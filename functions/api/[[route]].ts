import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { handle } from 'hono/cloudflare-pages'
import type {
  AppFeatures,
  ImportResult,
  InviteRecord,
  PaperRecord,
  RecommendationItem,
  RecommendationPayload,
  ResearchAspect,
  SessionPayload,
  UserSummary,
} from '../../src/lib/shared'

type Bindings = {
  DB: D1Database
  AI?: Ai
  VECTOR_INDEX?: VectorizeIndex
  APP_SECRET: string
  BOOTSTRAP_ADMIN_EMAILS?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SEMANTIC_SCHOLAR_API_KEY?: string
}

type Variables = {
  currentUser: UserRow | null
}

type AppContext = {
  Bindings: Bindings
  Variables: Variables
}

type UserRow = {
  id: string
  email: string
  normalized_email: string
  name: string
  avatar_url: string | null
  role: 'owner' | 'member'
  research_summary: string
  bio: string
  created_at: string
}

type LocalCredentialRow = {
  user_id: string
  password_hash: string
  salt: string
  iterations: number
  created_at: string
  updated_at: string
}

type InviteRow = {
  id: string
  code: string
  target_email: string | null
  normalized_target_email: string | null
  note: string
  max_uses: number
  used_count: number
  expires_at: string | null
  created_at: string
}

type PaperRow = {
  id: string
  owner_user_id: string
  owner_name?: string | null
  title: string
  bibtex: string
  abstract: string
  introduction: string
  tldr: string
  authors: string
  year: number | null
  venue: string
  source: 'manual' | 'dblp' | 'semantic-scholar'
  source_id: string | null
  external_url: string | null
  search_text: string
  embedding_json: string | null
  created_at: string
  updated_at: string
}

type OAuthProvider = 'github' | 'google'

type OAuthCookiePayload = {
  state: string
  inviteCode: string | null
  codeVerifier: string | null
}

type OAuthProfile = {
  provider: OAuthProvider
  providerUserId: string
  email: string
  name: string
  avatarUrl: string | null
}

const SESSION_COOKIE = 'wecites_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const OAUTH_COOKIE_MAX_AGE = 60 * 10
const PASSWORD_ITERATIONS = 15000
const PASSWORD_MIN_LENGTH = 8
const AI_EMBEDDING_DIMENSIONS = 768
const HASH_EMBEDDING_DIMENSIONS = 128
const DEFAULT_BOOTSTRAP_ADMIN_EMAILS = ['sci.m.wang@gmail.com']

const app = new Hono<AppContext>().basePath('/api')

app.use('*', async (c, next) => {
  c.set('currentUser', await getCurrentUser(c))
  await next()
})

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message }, error.status)
  }

  console.error(error)
  return c.json({ error: '服务器内部错误' }, 500)
})

app.get('/health', (c) => c.json({ ok: true, features: getFeatures(c.env) }))

app.get('/session', async (c) => {
  const user = c.get('currentUser')
  const features = getFeatures(c.env)
  const stats = user
    ? await getStats(c.env.DB, user.id)
    : { ownPaperCount: 0, networkPaperCount: 0 }
  const payload: SessionPayload = {
    user: user ? mapUser(user) : null,
    features,
    stats,
  }
  return c.json(payload)
})

app.post('/auth/register', async (c) => {
  const body = await safeJson<{
    email?: string
    password?: string
    name?: string
    inviteCode?: string
  }>(c)
  const email = requireEmail(body.email)
  const password = requirePassword(body.password)
  const normalizedEmail = normalizeEmail(email)
  const existingUser = await first<UserRow>(
    c.env.DB,
    `SELECT * FROM users WHERE normalized_email = ?`,
    normalizedEmail,
  )
  if (existingUser) {
    const existingCredential = await first<LocalCredentialRow>(
      c.env.DB,
      `SELECT * FROM local_credentials WHERE user_id = ?`,
      existingUser.id,
    )
    if (existingCredential) {
      throw new HTTPException(409, { message: '邮箱已注册，请直接登录' })
    }
    throw new HTTPException(409, { message: '该邮箱已存在，请使用已有登录方式' })
  }

  const inviteCode = body.inviteCode?.trim() ? normalizeInviteCode(body.inviteCode) : null
  const admission = await admitNewUser(c, email, inviteCode)
  const userId = crypto.randomUUID()
  const salt = randomToken(16)
  const passwordHash = await hashPassword(password, salt, PASSWORD_ITERATIONS)
  const displayName = body.name?.trim() || defaultNameForEmail(email)

  await run(
    c.env.DB,
    `INSERT INTO users (
      id, email, normalized_email, name, avatar_url, role,
      research_summary, bio, created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, '', '', ?, ?)`,
    userId,
    email,
    normalizedEmail,
    displayName,
    admission.role,
    nowIso(),
    nowIso(),
  )
  await run(
    c.env.DB,
    `INSERT INTO local_credentials (
      user_id, password_hash, salt, iterations, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    userId,
    passwordHash,
    salt,
    PASSWORD_ITERATIONS,
    nowIso(),
    nowIso(),
  )
  if (admission.invite) {
    await consumeInvite(c.env.DB, admission.invite, userId)
  }

  const session = await createSession(c.env.DB, userId)
  await setSessionCookie(c, session.rawToken)
  return c.json({ ok: true }, 201)
})

app.post('/auth/login', async (c) => {
  const body = await safeJson<{ email?: string; password?: string }>(c)
  const email = requireEmail(body.email)
  const password = requirePassword(body.password)
  const account = await first<UserRow & LocalCredentialRow>(
    c.env.DB,
    `SELECT users.*, local_credentials.user_id, local_credentials.password_hash,
      local_credentials.salt, local_credentials.iterations
      FROM users
      JOIN local_credentials ON local_credentials.user_id = users.id
      WHERE users.normalized_email = ?`,
    normalizeEmail(email),
  )

  if (!account) {
    throw new HTTPException(401, { message: '邮箱或密码错误' })
  }

  const isValid = await verifyPassword(password, account.salt, account.iterations, account.password_hash)
  if (!isValid) {
    throw new HTTPException(401, { message: '邮箱或密码错误' })
  }

  const session = await createSession(c.env.DB, account.id)
  await setSessionCookie(c, session.rawToken)
  return c.json({ ok: true })
})

app.post('/auth/start/:provider', async (c) => {
  const provider = requireProvider(c.req.param('provider'))
  const body = await safeJson<{ inviteCode?: string }>(c)
  const inviteCode = body.inviteCode?.trim() ? normalizeInviteCode(body.inviteCode) : null
  const authUrl = await buildAuthorizationUrl(c, provider, inviteCode)
  return c.json({ url: authUrl })
})

app.get('/auth/callback/:provider', async (c) => {
  const provider = requireProvider(c.req.param('provider'))
  try {
    const session = await completeOAuth(c, provider)
    await setSessionCookie(c, session.rawToken)
    return c.redirect('/?auth=ok')
  } catch (error) {
    const message = error instanceof Error ? error.message : '登录失败'
    return c.redirect(`/?authError=${encodeURIComponent(message)}`)
  }
})

app.post('/auth/logout', async (c) => {
  const rawToken = getCookie(c, SESSION_COOKIE)
  if (rawToken) {
    await deleteSession(c.env.DB, rawToken)
  }
  clearSessionCookie(c)
  return c.body(null, 204)
})

app.put('/profile', async (c) => {
  const user = requireUser(c)
  const body = await safeJson<{ name?: string; researchSummary?: string; bio?: string }>(c)
  const name = body.name?.trim() || user.name
  const researchSummary = body.researchSummary?.trim() ?? user.research_summary
  const bio = body.bio?.trim() ?? user.bio

  await run(
    c.env.DB,
    `UPDATE users
      SET name = ?, research_summary = ?, bio = ?, updated_at = ?
      WHERE id = ?`,
    name,
    researchSummary,
    bio,
    nowIso(),
    user.id,
  )

  return c.json({ ok: true })
})

app.get('/invites', async (c) => {
  const user = requireUser(c)
  const rows = await all<InviteRow>(
    c.env.DB,
    `SELECT id, code, target_email, normalized_target_email, note, max_uses, used_count, expires_at, created_at
      FROM invites
      WHERE created_by_user_id = ?
      ORDER BY created_at DESC`,
    user.id,
  )
  return c.json(rows.map(mapInvite))
})

app.post('/invites', async (c) => {
  const user = requireUser(c)
  const body = await safeJson<{
    targetEmail?: string
    note?: string
    maxUses?: number
    expiresInDays?: number
  }>(c)

  const maxUses = clamp(Number(body.maxUses ?? 1), 1, 20)
  const expiresInDays = clamp(Number(body.expiresInDays ?? 14), 1, 365)
  const targetEmail = body.targetEmail?.trim() || null
  const invite: InviteRecord = {
    id: crypto.randomUUID(),
    code: makeInviteCode(),
    targetEmail,
    note: body.note?.trim() || '',
    maxUses,
    usedCount: 0,
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: nowIso(),
  }

  await run(
    c.env.DB,
    `INSERT INTO invites (
      id, code, created_by_user_id, target_email, normalized_target_email,
      note, max_uses, used_count, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    invite.id,
    invite.code,
    user.id,
    invite.targetEmail,
    invite.targetEmail ? normalizeEmail(invite.targetEmail) : null,
    invite.note,
    invite.maxUses,
    invite.usedCount,
    invite.expiresAt,
    invite.createdAt,
  )

  return c.json(invite, 201)
})

app.get('/papers', async (c) => {
  const user = requireUser(c)
  const rows = await all<PaperRow>(
    c.env.DB,
    `SELECT *
      FROM papers
      WHERE owner_user_id = ?
      ORDER BY updated_at DESC`,
    user.id,
  )
  return c.json(rows.map((row) => mapPaper(row, null)))
})

app.post('/papers', async (c) => {
  const user = requireUser(c)
  const paper = await upsertPaper(c, user.id)
  return c.json(paper, 201)
})

app.put('/papers/:paperId', async (c) => {
  const user = requireUser(c)
  const paperId = c.req.param('paperId')
  const existing = await first<PaperRow>(
    c.env.DB,
    `SELECT * FROM papers WHERE id = ? AND owner_user_id = ?`,
    paperId,
    user.id,
  )
  if (!existing) {
    throw new HTTPException(404, { message: '论文不存在' })
  }

  const paper = await upsertPaper(c, user.id, paperId)
  return c.json(paper)
})

app.delete('/papers/:paperId', async (c) => {
  const user = requireUser(c)
  const paperId = c.req.param('paperId')
  await run(c.env.DB, `DELETE FROM papers WHERE id = ? AND owner_user_id = ?`, paperId, user.id)
  if (c.env.VECTOR_INDEX) {
    await c.env.VECTOR_INDEX.deleteByIds([paperId])
  }
  return c.body(null, 204)
})

app.get('/import/dblp', async (c) => {
  requireUser(c)
  const query = c.req.query('q')?.trim()
  if (!query) {
    throw new HTTPException(400, { message: '缺少检索关键词' })
  }

  const response = await fetch(
    `https://dblp.org/search/publ/api?${new URLSearchParams({
      q: query,
      format: 'json',
      h: '8',
    }).toString()}`,
  )
  if (!response.ok) {
    throw new HTTPException(502, { message: 'DBLP 检索失败' })
  }

  const payload = (await response.json()) as any
  const hits = arrayify(payload?.result?.hits?.hit)
  const results = await Promise.all(
    hits.map(async (hit: any) => {
      const info = hit.info ?? {}
      const authors = extractDblpAuthors(info.authors)
      const sourceId = typeof info.key === 'string' ? info.key : null
      let bibtex = buildGeneratedBibtex({
        title: stringifyValue(info.title),
        authors,
        year: toNumber(info.year),
        venue: stringifyValue(info.venue),
        url: stringifyValue(info.url),
      })

      if (sourceId) {
        const bibResponse = await fetch(`https://dblp.org/rec/${sourceId}.bib`)
        if (bibResponse.ok) {
          bibtex = (await bibResponse.text()).trim() || bibtex
        }
      }

      const result: ImportResult = {
        source: 'dblp',
        sourceId,
        title: stringifyValue(info.title),
        authors,
        abstract: '',
        introduction: '',
        tldr: '',
        venue: stringifyValue(info.venue),
        year: toNumber(info.year),
        externalUrl: stringifyValue(info.url),
        bibtex,
      }
      return result
    }),
  )

  return c.json(results.filter((item) => item.title))
})

app.get('/import/semantic-scholar', async (c) => {
  requireUser(c)
  const query = c.req.query('q')?.trim()
  if (!query) {
    throw new HTTPException(400, { message: '缺少检索关键词' })
  }

  const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search')
  url.searchParams.set('query', query)
  url.searchParams.set('limit', '8')
  url.searchParams.set(
    'fields',
    'paperId,title,abstract,authors,year,venue,url,tldr,externalIds',
  )

  const headers: HeadersInit = {}
  if (c.env.SEMANTIC_SCHOLAR_API_KEY) {
    headers['x-api-key'] = c.env.SEMANTIC_SCHOLAR_API_KEY
  }

  const response = await fetch(url.toString(), { headers })
  if (!response.ok) {
    throw new HTTPException(502, { message: 'Semantic Scholar 检索失败' })
  }

  const payload = (await response.json()) as any
  const results: ImportResult[] = arrayify(payload?.data).map((item: any) => {
    const authors = arrayify(item?.authors).map((author: any) => stringifyValue(author?.name)).filter(Boolean)
    return {
      source: 'semantic-scholar',
      sourceId: stringifyValue(item?.paperId),
      title: stringifyValue(item?.title),
      authors,
      abstract: stringifyValue(item?.abstract),
      introduction: '',
      tldr: stringifyValue(item?.tldr?.text),
      venue: stringifyValue(item?.venue),
      year: toNumber(item?.year),
      externalUrl: stringifyValue(item?.url),
      bibtex: buildGeneratedBibtex({
        title: stringifyValue(item?.title),
        authors,
        year: toNumber(item?.year),
        venue: stringifyValue(item?.venue),
        url: stringifyValue(item?.url),
      }),
    }
  })

  return c.json(results.filter((item) => item.title))
})

app.post('/recommendations', async (c) => {
  const user = requireUser(c)
  const body = await safeJson<{ extraContext?: string }>(c)
  const queryText = `${user.research_summary}\n\n${user.bio}\n\n${body.extraContext?.trim() ?? ''}`.trim()
  if (!queryText) {
    throw new HTTPException(400, { message: '请先填写研究工作或个人简介' })
  }

  const analysis = await analyzeResearchText(c.env, queryText)
  const queryEmbedding = await buildEmbedding(c.env, `${queryText}\n\n${flattenAspects(analysis.aspects)}`)
  const rows = await loadRecommendationCandidates(c.env, user.id, queryEmbedding)

  const items: RecommendationItem[] = rows
    .map((row) => scorePaper(row, queryEmbedding, analysis.aspects))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20)

  const payload: RecommendationPayload = {
    aspects: analysis.aspects,
    recommendations: items,
    queryText,
    usedAi: analysis.usedAi,
  }

  return c.json(payload)
})

export const onRequest = handle(app)

function getFeatures(env: Bindings): AppFeatures {
  return {
    githubAuth: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    googleAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    aiAnalysis: Boolean(env.AI),
    vectorSearch: Boolean(env.AI && env.VECTOR_INDEX),
    semanticScholarImport: true,
  }
}

async function getStats(db: D1Database, userId: string) {
  const own = await first<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM papers WHERE owner_user_id = ?`,
    userId,
  )
  const network = await first<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM papers WHERE owner_user_id != ?`,
    userId,
  )
  return {
    ownPaperCount: own?.count ?? 0,
    networkPaperCount: network?.count ?? 0,
  }
}

function requireUser(c: Context<AppContext>) {
  const user = c.get('currentUser')
  if (!user) {
    throw new HTTPException(401, { message: '请先登录' })
  }
  return user
}

function requireProvider(value: string): OAuthProvider {
  if (value === 'github' || value === 'google') {
    return value
  }
  throw new HTTPException(404, { message: '不支持的登录方式' })
}

function requireEmail(email: string | undefined) {
  const value = email?.trim() ?? ''
  if (!value || !EMAIL_PATTERN.test(value)) {
    throw new HTTPException(400, { message: '请输入有效邮箱' })
  }
  return value
}

function requirePassword(password: string | undefined) {
  const value = password ?? ''
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new HTTPException(400, { message: `密码至少 ${PASSWORD_MIN_LENGTH} 位` })
  }
  return value
}

function defaultNameForEmail(email: string) {
  return email.split('@')[0] || 'Researcher'
}

async function buildAuthorizationUrl(
  c: Context<AppContext>,
  provider: OAuthProvider,
  inviteCode: string | null,
) {
  const origin = new URL(c.req.url).origin
  const state = randomToken(24)
  const redirectUri = `${origin}/api/auth/callback/${provider}`
  const codeVerifier = provider === 'google' ? randomToken(48) : null
  const payload: OAuthCookiePayload = { state, inviteCode, codeVerifier }
  await setSignedCookie(c, `wecites_oauth_${provider}`, payload, OAUTH_COOKIE_MAX_AGE)

  if (provider === 'github') {
    if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
      throw new HTTPException(503, { message: 'GitHub OAuth 尚未配置' })
    }
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', 'read:user user:email')
    url.searchParams.set('state', state)
    return url.toString()
  }

  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    throw new HTTPException(503, { message: 'Google OAuth 尚未配置' })
  }

  const challenge = codeVerifier ? await makeCodeChallenge(codeVerifier) : ''
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

async function completeOAuth(c: Context<AppContext>, provider: OAuthProvider) {
  const cookieName = `wecites_oauth_${provider}`
  const saved = await getSignedCookie<OAuthCookiePayload>(c, cookieName)
  deleteCookie(c, cookieName, { path: '/' })
  if (!saved) {
    throw new Error('OAuth 状态丢失，请重新发起登录')
  }

  const state = c.req.query('state')
  const code = c.req.query('code')
  if (!state || !code || state !== saved.state) {
    throw new Error('OAuth 校验失败')
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback/${provider}`
  const profile =
    provider === 'github'
      ? await fetchGithubProfile(c.env, code, redirectUri)
      : await fetchGoogleProfile(c.env, code, redirectUri, saved.codeVerifier)

  const existingAccount = await first<{ user_id: string }>(
    c.env.DB,
    `SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?`,
    provider,
    profile.providerUserId,
  )

  let userId = existingAccount?.user_id ?? null
  if (!userId) {
    const existingUser = await first<UserRow>(
      c.env.DB,
      `SELECT * FROM users WHERE normalized_email = ?`,
      normalizeEmail(profile.email),
    )
    if (existingUser) {
      userId = existingUser.id
    }
  }

  if (!userId) {
    const admission = await admitNewUser(c, profile.email, saved.inviteCode)
    userId = crypto.randomUUID()
    await run(
      c.env.DB,
      `INSERT INTO users (
        id, email, normalized_email, name, avatar_url, role,
        research_summary, bio, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
      userId,
      profile.email,
      normalizeEmail(profile.email),
      profile.name,
      profile.avatarUrl,
      admission.role,
      nowIso(),
      nowIso(),
    )
    if (admission.invite) {
      await consumeInvite(c.env.DB, admission.invite, userId)
    }
  }

  await run(
    c.env.DB,
    `INSERT OR IGNORE INTO oauth_accounts (
      id, user_id, provider, provider_user_id, email, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    userId,
    provider,
    profile.providerUserId,
    profile.email,
    nowIso(),
  )

  return createSession(c.env.DB, userId)
}

async function admitNewUser(
  c: Context<AppContext>,
  email: string,
  inviteCode: string | null,
): Promise<{ role: 'owner' | 'member'; invite: InviteRow | null }> {
  const normalizedEmail = normalizeEmail(email)
  const bootstrapEmails = getBootstrapAdminEmails(c.env)
  if (bootstrapEmails.includes(normalizedEmail)) {
    return { role: 'owner', invite: null }
  }

  if (!inviteCode) {
    throw new HTTPException(403, { message: '新用户需要邀请码' })
  }

  const invite = await first<InviteRow>(
    c.env.DB,
    `SELECT id, code, target_email, normalized_target_email, note, max_uses, used_count, expires_at, created_at
      FROM invites
      WHERE code = ?`,
    normalizeInviteCode(inviteCode),
  )

  if (!invite) {
    throw new HTTPException(404, { message: '邀请码不存在' })
  }
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    throw new HTTPException(410, { message: '邀请码已过期' })
  }
  if (invite.used_count >= invite.max_uses) {
    throw new HTTPException(409, { message: '邀请码已使用完' })
  }
  if (invite.normalized_target_email && invite.normalized_target_email !== normalizedEmail) {
    throw new HTTPException(403, { message: '该邀请码仅限指定邮箱使用' })
  }

  return { role: 'member', invite }
}

function getBootstrapAdminEmails(env: Bindings) {
  return Array.from(
    new Set(
      [...DEFAULT_BOOTSTRAP_ADMIN_EMAILS, ...(env.BOOTSTRAP_ADMIN_EMAILS ?? '').split(',')]
        .map((value) => normalizeEmail(value))
        .filter(Boolean),
    ),
  )
}

async function consumeInvite(db: D1Database, invite: InviteRow, userId: string) {
  await run(
    db,
    `UPDATE invites SET used_count = used_count + 1 WHERE id = ?`,
    invite.id,
  )
  await run(
    db,
    `INSERT INTO invite_redemptions (id, invite_id, user_id, redeemed_at)
      VALUES (?, ?, ?, ?)`,
    crypto.randomUUID(),
    invite.id,
    userId,
    nowIso(),
  )
}

async function createSession(db: D1Database, userId: string) {
  const rawToken = randomToken(32)
  const tokenHash = await sha256(rawToken)
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString()
  await run(
    db,
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
    nowIso(),
  )
  return { rawToken }
}

async function hashPassword(password: string, saltHex: string, iterations: number) {
  let digest = new TextEncoder().encode(`${saltHex}:${password}`)
  for (let round = 0; round < iterations; round += 1) {
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digest))
  }
  return bytesToHex(digest)
}

async function verifyPassword(
  password: string,
  saltHex: string,
  iterations: number,
  expectedHash: string,
) {
  const computedHash = await hashPassword(password, saltHex, iterations)
  return timingSafeEqual(computedHash, expectedHash)
}

async function getCurrentUser(c: Context<AppContext>) {
  const rawToken = getCookie(c, SESSION_COOKIE)
  if (!rawToken) {
    return null
  }

  const tokenHash = await sha256(rawToken)
  const row = await first<UserRow & { expires_at: string }>(
    c.env.DB,
    `SELECT users.*, sessions.expires_at
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?`,
    tokenHash,
  )

  if (!row) {
    clearSessionCookie(c)
    return null
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await deleteSession(c.env.DB, rawToken)
    clearSessionCookie(c)
    return null
  }

  return row
}

async function deleteSession(db: D1Database, rawToken: string) {
  const tokenHash = await sha256(rawToken)
  await run(db, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
}

async function setSessionCookie(c: Context<AppContext>, rawToken: string) {
  setCookie(c, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

function clearSessionCookie(c: Context<AppContext>) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

async function fetchGithubProfile(
  env: Bindings,
  code: string,
  redirectUri: string,
): Promise<OAuthProfile> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new Error('GitHub OAuth 尚未配置')
  }

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const tokenPayload = (await tokenResponse.json()) as { access_token?: string }
  if (!tokenPayload.access_token) {
    throw new Error('GitHub access token 获取失败')
  }

  const headers = {
    authorization: `Bearer ${tokenPayload.access_token}`,
    accept: 'application/json',
    'user-agent': 'we-cites',
  }
  const profileResponse = await fetch('https://api.github.com/user', { headers })
  const emailResponse = await fetch('https://api.github.com/user/emails', { headers })
  const profile = (await profileResponse.json()) as any
  const emails = (await emailResponse.json()) as Array<{
    email: string
    primary: boolean
    verified: boolean
  }>
  const primaryEmail = emails.find((item) => item.primary && item.verified) ?? emails.find((item) => item.verified)

  if (!primaryEmail?.email) {
    throw new Error('GitHub 账号没有可用的已验证邮箱')
  }

  return {
    provider: 'github',
    providerUserId: String(profile.id),
    email: primaryEmail.email,
    name: profile.name || profile.login || primaryEmail.email,
    avatarUrl: profile.avatar_url ?? null,
  }
}

async function fetchGoogleProfile(
  env: Bindings,
  code: string,
  redirectUri: string,
  codeVerifier: string | null,
): Promise<OAuthProfile> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth 尚未配置')
  }
  if (!codeVerifier) {
    throw new Error('Google PKCE 信息缺失')
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  const tokenPayload = (await tokenResponse.json()) as { access_token?: string }
  if (!tokenPayload.access_token) {
    throw new Error('Google access token 获取失败')
  }

  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
  })
  const profile = (await profileResponse.json()) as any
  if (!profile.email || !profile.email_verified) {
    throw new Error('Google 账号没有可用的已验证邮箱')
  }

  return {
    provider: 'google',
    providerUserId: String(profile.sub),
    email: profile.email,
    name: profile.name || profile.email,
    avatarUrl: profile.picture ?? null,
  }
}

async function upsertPaper(
  c: Context<AppContext>,
  ownerUserId: string,
  paperId?: string,
): Promise<PaperRecord> {
  const body = await safeJson<{
    title?: string
    bibtex?: string
    abstract?: string
    introduction?: string
    tldr?: string
  }>(c)

  const bibtex = body.bibtex?.trim() ?? ''
  if (!bibtex) {
    throw new HTTPException(400, { message: 'bibtex 必填' })
  }

  const parsedBibtex = parseBibtexMetadata(bibtex)
  const title = body.title?.trim() || parsedBibtex.title
  if (!title) {
    throw new HTTPException(400, { message: 'title 必填，或在 bibtex 中提供 title 字段' })
  }

  const authors = parsedBibtex.authors
  const paperRow: PaperRow = {
    id: paperId ?? crypto.randomUUID(),
    owner_user_id: ownerUserId,
    title,
    bibtex,
    abstract: body.abstract?.trim() ?? '',
    introduction: body.introduction?.trim() ?? '',
    tldr: body.tldr?.trim() ?? '',
    authors: JSON.stringify(authors),
    year: parsedBibtex.year,
    venue: parsedBibtex.venue,
    source: 'manual',
    source_id: null,
    external_url: parsedBibtex.url,
    search_text: '',
    embedding_json: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  }

  const searchText = buildPaperSearchText({
    title: paperRow.title,
    abstract: paperRow.abstract,
    introduction: paperRow.introduction,
    tldr: paperRow.tldr,
    venue: paperRow.venue,
    authors,
  })
  const embedding = await buildEmbedding(c.env, searchText)

  if (paperId) {
    await run(
      c.env.DB,
      `UPDATE papers SET
        title = ?, bibtex = ?, abstract = ?, introduction = ?, tldr = ?, authors = ?,
        year = ?, venue = ?, source = ?, source_id = ?, external_url = ?,
        search_text = ?, embedding_json = ?, updated_at = ?
        WHERE id = ? AND owner_user_id = ?`,
      paperRow.title,
      paperRow.bibtex,
      paperRow.abstract,
      paperRow.introduction,
      paperRow.tldr,
      paperRow.authors,
      paperRow.year,
      paperRow.venue,
      paperRow.source,
      paperRow.source_id,
      paperRow.external_url,
      searchText,
      JSON.stringify(embedding),
      paperRow.updated_at,
      paperId,
      ownerUserId,
    )
  } else {
    await run(
      c.env.DB,
      `INSERT INTO papers (
        id, owner_user_id, title, bibtex, abstract, introduction, tldr,
        authors, year, venue, source, source_id, external_url,
        search_text, embedding_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      paperRow.id,
      paperRow.owner_user_id,
      paperRow.title,
      paperRow.bibtex,
      paperRow.abstract,
      paperRow.introduction,
      paperRow.tldr,
      paperRow.authors,
      paperRow.year,
      paperRow.venue,
      paperRow.source,
      paperRow.source_id,
      paperRow.external_url,
      searchText,
      JSON.stringify(embedding),
      paperRow.created_at,
      paperRow.updated_at,
    )
  }

  if (c.env.AI && c.env.VECTOR_INDEX && embedding.length === AI_EMBEDDING_DIMENSIONS) {
    await c.env.VECTOR_INDEX.upsert([
      {
        id: paperRow.id,
        values: embedding,
        metadata: {
          ownerUserId,
          title: paperRow.title,
          venue: paperRow.venue,
        },
      },
    ])
  }

  const stored = await first<PaperRow>(c.env.DB, `SELECT * FROM papers WHERE id = ?`, paperRow.id)
  if (!stored) {
    throw new HTTPException(500, { message: '论文保存失败' })
  }

  return mapPaper(stored, null)
}

async function analyzeResearchText(env: Bindings, queryText: string) {
  if (!env.AI) {
    return { aspects: extractAspectsFallback(queryText), usedAi: false }
  }

  try {
    const response = (await runAi(env.AI, '@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content:
            'You extract 3 to 6 research aspects from a researcher profile. Return compact JSON: {"aspects":[{"label":"...","keywords":["...","..."]}]}. Each label should be short. Keywords should be concrete and useful for citation matching.',
        },
        {
          role: 'user',
          content: queryText,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 350,
      temperature: 0.2,
    })) as { response?: string }

    const parsed = JSON.parse(response.response ?? '{}') as { aspects?: ResearchAspect[] }
    const aspects = sanitizeAspects(parsed.aspects)
    if (!aspects.length) {
      throw new Error('empty aspects')
    }
    return { aspects, usedAi: true }
  } catch {
    return { aspects: extractAspectsFallback(queryText), usedAi: false }
  }
}

async function loadRecommendationCandidates(
  env: Bindings,
  ownerUserId: string,
  queryEmbedding: number[],
) {
  if (env.AI && env.VECTOR_INDEX && queryEmbedding.length === AI_EMBEDDING_DIMENSIONS) {
    try {
      const raw = (await env.VECTOR_INDEX.query(queryEmbedding, {
        topK: 60,
      })) as unknown as {
        matches?: Array<{ id?: string }>
      }
      const ids = arrayify(raw.matches)
        .map((match) => String(match.id ?? '').trim())
        .filter(Boolean)

      if (ids.length) {
        const placeholders = ids.map(() => '?').join(', ')
        const rows = await all<PaperRow>(
          env.DB,
          `SELECT papers.*, users.name AS owner_name
            FROM papers
            JOIN users ON users.id = papers.owner_user_id
            WHERE papers.id IN (${placeholders}) AND papers.owner_user_id != ?`,
          ...ids,
          ownerUserId,
        )
        if (rows.length) {
          return rows
        }
      }
    } catch {
      // Fall through to D1-based ranking when Vectorize is unavailable.
    }
  }

  return all<PaperRow>(
    env.DB,
    `SELECT papers.*, users.name AS owner_name
      FROM papers
      JOIN users ON users.id = papers.owner_user_id
      WHERE papers.owner_user_id != ?
      ORDER BY papers.updated_at DESC
      LIMIT 500`,
    ownerUserId,
  )
}

async function buildEmbedding(env: Bindings, text: string) {
  const cleaned = text.trim().slice(0, 4000)
  if (!cleaned) {
    return hashEmbedding('', HASH_EMBEDDING_DIMENSIONS)
  }

  if (env.AI) {
    try {
      const result = (await runAi(env.AI, '@cf/baai/bge-base-en-v1.5', {
        text: [cleaned],
      })) as { data?: number[][] }
      const vector = result.data?.[0]
      if (Array.isArray(vector) && vector.length) {
        return vector
      }
    } catch {
      return hashEmbedding(cleaned, HASH_EMBEDDING_DIMENSIONS)
    }
  }

  return hashEmbedding(cleaned, HASH_EMBEDDING_DIMENSIONS)
}

function scorePaper(
  row: PaperRow,
  queryEmbedding: number[],
  aspects: ResearchAspect[],
): RecommendationItem {
  const paper = mapPaper(row, row.owner_name ?? null)
  const lowerText = [paper.title, paper.abstract, paper.introduction, paper.tldr, paper.venue]
    .join(' ')
    .toLowerCase()
  let paperEmbedding = parseEmbedding(row.embedding_json)
  if (!paperEmbedding || paperEmbedding.length !== queryEmbedding.length) {
    paperEmbedding = hashEmbedding(row.search_text, queryEmbedding.length)
  }

  const vectorScore = cosineSimilarity(queryEmbedding, paperEmbedding)
  const matchedAspects = aspects
    .map((aspect) => ({
      label: aspect.label,
      matches: aspect.keywords.filter((keyword) => lowerText.includes(keyword.toLowerCase())),
    }))
    .filter((entry) => entry.matches.length)
  const matchedKeywords = Array.from(new Set(matchedAspects.flatMap((entry) => entry.matches)))
  const keywordScore = matchedKeywords.length / Math.max(1, aspects.flatMap((aspect) => aspect.keywords).length)
  const score = vectorScore * 0.75 + keywordScore * 0.25

  return {
    paper,
    score,
    matchedAspects: matchedAspects.map((entry) => entry.label),
    matchedKeywords,
    reason: matchedKeywords.length
      ? `命中关键词：${matchedKeywords.slice(0, 6).join(', ')}`
      : '主要基于整体研究语义相似度匹配',
  }
}

function mapUser(user: UserRow): UserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    role: user.role,
    researchSummary: user.research_summary,
    bio: user.bio,
    createdAt: user.created_at,
  }
}

function mapInvite(invite: InviteRow): InviteRecord {
  return {
    id: invite.id,
    code: invite.code,
    targetEmail: invite.target_email,
    note: invite.note,
    maxUses: invite.max_uses,
    usedCount: invite.used_count,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  }
}

function mapPaper(row: PaperRow, ownerName: string | null): PaperRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerName,
    title: row.title,
    bibtex: row.bibtex,
    abstract: row.abstract,
    introduction: row.introduction,
    tldr: row.tldr,
    authors: parseStringArray(row.authors),
    year: row.year,
    venue: row.venue,
    source: row.source,
    sourceId: row.source_id,
    externalUrl: row.external_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function buildPaperSearchText(input: {
  title: string
  abstract: string
  introduction: string
  tldr: string
  venue: string
  authors: string[]
}) {
  return [
    input.title,
    input.abstract,
    input.introduction,
    input.tldr,
    input.venue,
    input.authors.join(', '),
  ]
    .filter(Boolean)
    .join('\n')
}

function extractAspectsFallback(text: string): ResearchAspect[] {
  const tokens = Array.from(
    new Set(
      text
        .toLowerCase()
        .match(/[\p{L}\p{N}-]{3,}/gu)
        ?.filter((token) => !STOPWORDS.has(token)) ?? [],
    ),
  ).slice(0, 12)
  if (!tokens.length) {
    return [{ label: 'General fit', keywords: ['research', 'paper', 'method'] }]
  }

  const chunks = [tokens.slice(0, 3), tokens.slice(3, 6), tokens.slice(6, 9), tokens.slice(9, 12)].filter(
    (chunk) => chunk.length,
  )
  return chunks.slice(0, 4).map((chunk) => ({
    label: toTitleCase(chunk[0]),
    keywords: chunk,
  }))
}

function sanitizeAspects(input: ResearchAspect[] | undefined) {
  return arrayify(input)
    .map((aspect) => ({
      label: String(aspect.label ?? '').trim().slice(0, 60),
      keywords: arrayify(aspect.keywords)
        .map((keyword) => String(keyword).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 6),
    }))
    .filter((aspect) => aspect.label && aspect.keywords.length)
    .slice(0, 6)
}

function flattenAspects(aspects: ResearchAspect[]) {
  return aspects.map((aspect) => `${aspect.label}: ${aspect.keywords.join(', ')}`).join('\n')
}

function hashEmbedding(text: string, dimensions: number) {
  const vector = new Array<number>(dimensions).fill(0)
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}-]{2,}/gu) ?? [text.toLowerCase()]
  for (const token of tokens) {
    const hash = simpleHash(token)
    const index = Math.abs(hash) % dimensions
    const sign = hash % 2 === 0 ? 1 : -1
    vector[index] += sign * (1 + token.length / 20)
  }
  return normalizeVector(vector)
}

function parseEmbedding(value: string | null) {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as number[]
    if (!Array.isArray(parsed)) {
      return null
    }
    return parsed.map((item) => Number(item))
  } catch {
    return null
  }
}

function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) {
    return 0
  }
  let sum = 0
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index]
  }
  return sum
}

function normalizeVector(vector: number[]) {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map((value) => value / length)
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as string[]
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

function parseBibtexMetadata(bibtex: string) {
  const fields = parseBibtexFields(bibtex)
  const title = pickBibtexField(fields, ['title'])
  const authors = parseBibtexAuthors(pickBibtexField(fields, ['author']))
  const venue = pickBibtexField(fields, [
    'journal',
    'booktitle',
    'series',
    'publisher',
    'school',
    'institution',
    'organization',
    'howpublished',
  ])
  const url = pickBibtexField(fields, ['url', 'ee']) || null
  const yearMatch = pickBibtexField(fields, ['year']).match(/\d{4}/)

  return {
    title,
    authors,
    venue,
    url,
    year: yearMatch ? Number(yearMatch[0]) : null,
  }
}

function parseBibtexFields(bibtex: string) {
  const fields: Record<string, string> = {}
  const headerEnd = bibtex.indexOf(',')
  if (headerEnd === -1) {
    return fields
  }

  let index = headerEnd + 1
  while (index < bibtex.length) {
    while (index < bibtex.length && /[\s,]/.test(bibtex[index])) {
      index += 1
    }
    if (index >= bibtex.length || bibtex[index] === '}') {
      break
    }

    const keyStart = index
    while (index < bibtex.length && /[A-Za-z0-9_-]/.test(bibtex[index])) {
      index += 1
    }
    const key = bibtex.slice(keyStart, index).toLowerCase()

    while (index < bibtex.length && /\s/.test(bibtex[index])) {
      index += 1
    }
    if (bibtex[index] !== '=') {
      while (index < bibtex.length && bibtex[index] !== ',') {
        index += 1
      }
      continue
    }

    index += 1
    while (index < bibtex.length && /\s/.test(bibtex[index])) {
      index += 1
    }

    let value = ''
    if (bibtex[index] === '{') {
      const [nextIndex, parsed] = readBraceValue(bibtex, index)
      index = nextIndex
      value = parsed
    } else if (bibtex[index] === '"') {
      const [nextIndex, parsed] = readQuotedValue(bibtex, index)
      index = nextIndex
      value = parsed
    } else {
      const valueStart = index
      while (index < bibtex.length && bibtex[index] !== ',' && bibtex[index] !== '}') {
        index += 1
      }
      value = bibtex.slice(valueStart, index)
    }

    if (key) {
      fields[key] = normalizeBibtexValue(value)
    }
  }

  return fields
}

function readBraceValue(input: string, startIndex: number): [number, string] {
  let depth = 0
  let index = startIndex
  let value = ''

  while (index < input.length) {
    const char = input[index]
    if (char === '{') {
      depth += 1
      if (depth > 1) {
        value += char
      }
      index += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      index += 1
      if (depth === 0) {
        break
      }
      value += char
      continue
    }

    value += char
    index += 1
  }

  return [index, value]
}

function readQuotedValue(input: string, startIndex: number): [number, string] {
  let index = startIndex + 1
  let value = ''

  while (index < input.length) {
    const char = input[index]
    if (char === '"' && input[index - 1] !== '\\') {
      index += 1
      break
    }

    value += char
    index += 1
  }

  return [index, value]
}

function normalizeBibtexValue(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[{}]/g, '').trim()
}

function pickBibtexField(fields: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    if (fields[key]) {
      return fields[key]
    }
  }
  return ''
}

function parseBibtexAuthors(authorField: string) {
  if (!authorField) {
    return []
  }
  return authorField
    .split(/\s+and\s+/i)
    .map((author) => author.trim())
    .filter(Boolean)
}

function buildGeneratedBibtex(input: {
  title: string
  authors: string[]
  year: number | null
  venue: string
  url: string | null
}) {
  const key = makeBibtexKey(input.title, input.authors, input.year)
  const authorValue = input.authors.join(' and ') || 'Unknown'
  const venueField = input.venue ? `  howpublished = {${escapeBibtexValue(input.venue)}},\n` : ''
  const urlField = input.url ? `  url = {${escapeBibtexValue(input.url)}},\n` : ''
  const yearField = input.year ? `  year = {${input.year}},\n` : ''
  return `@misc{${key},\n  title = {${escapeBibtexValue(input.title)}},\n  author = {${escapeBibtexValue(authorValue)}},\n${yearField}${venueField}${urlField}}`
}

function makeBibtexKey(title: string, authors: string[], year: number | null) {
  const authorPart = (authors[0] ?? 'paper').split(/\s+/).pop()?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'paper'
  const titlePart = title
    .split(/\s+/)
    .slice(0, 2)
    .join('')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
  return `${authorPart}${year ?? 'noyear'}${titlePart || 'paper'}`
}

function escapeBibtexValue(value: string) {
  return value.replace(/[{}]/g, '')
}

function extractDblpAuthors(value: any) {
  return arrayify(value?.author)
    .map((author) => stringifyValue(author?.text ?? author))
    .filter(Boolean)
}

async function safeJson<T>(c: Context<AppContext>) {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

async function all<T>(db: D1Database, sql: string, ...bindings: unknown[]) {
  const result = await db.prepare(sql).bind(...bindings).all<T>()
  return result.results ?? []
}

async function first<T>(db: D1Database, sql: string, ...bindings: unknown[]) {
  return (await db.prepare(sql).bind(...bindings).first<T>()) ?? null
}

async function run(db: D1Database, sql: string, ...bindings: unknown[]) {
  return db.prepare(sql).bind(...bindings).run()
}

function nowIso() {
  return new Date().toISOString()
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function normalizeInviteCode(code: string) {
  return code.trim().toUpperCase()
}

function makeInviteCode() {
  return `INV-${randomToken(8).slice(0, 8).toUpperCase()}`
}

function randomToken(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

async function makeCodeChallenge(codeVerifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return toBase64Url(new Uint8Array(digest))
}

async function setSignedCookie(
  c: Context<AppContext>,
  name: string,
  value: unknown,
  maxAge: number,
) {
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
  const signature = await sign(c.env.APP_SECRET, encoded)
  setCookie(c, name, `${encoded}.${signature}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge,
  })
}

async function getSignedCookie<T>(c: Context<AppContext>, name: string) {
  const raw = getCookie(c, name)
  if (!raw) {
    return null
  }
  const [encoded, signature] = raw.split('.')
  if (!encoded || !signature) {
    return null
  }
  const expected = await sign(c.env.APP_SECRET, encoded)
  if (expected !== signature) {
    return null
  }
  try {
    const decoded = new TextDecoder().decode(fromBase64Url(encoded))
    return JSON.parse(decoded) as T
  } catch {
    return null
  }
}

async function sign(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return toBase64Url(new Uint8Array(signature))
}

async function runAi(ai: Ai, model: string, payload: unknown) {
  const runner = ai as unknown as {
    run: (modelName: string, input: unknown) => Promise<unknown>
  }
  return runner.run(model, payload)
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false
  }
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return mismatch === 0
}

function toBase64Url(bytes: Uint8Array) {
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4 || 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function arrayify<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) {
    return value
  }
  if (value === undefined || value === null) {
    return []
  }
  return [value]
}

function stringifyValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function toNumber(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function simpleHash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

function toTitleCase(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

const STOPWORDS = new Set([
  'about',
  'after',
  'also',
  'among',
  'and',
  'are',
  'based',
  'been',
  'between',
  'from',
  'have',
  'into',
  'more',
  'that',
  'than',
  'their',
  'there',
  'these',
  'this',
  'through',
  'using',
  'with',
  'works',
  '研究',
  '方向',
  '相关',
  '以及',
  '问题',
])

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

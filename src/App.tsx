import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type {
  ApiError,
  AuthProvider,
  ImportResult,
  InviteRecord,
  PaperRecord,
  RecommendationPayload,
  SessionPayload,
} from './lib/shared'
import { emptyFeatures } from './lib/shared'

type ProfileForm = {
  name: string
  researchSummary: string
  bio: string
}

type PaperForm = {
  title: string
  bibtex: string
  abstract: string
  introduction: string
  tldr: string
  authorsText: string
  year: string
  venue: string
  source: 'manual' | 'dblp' | 'semantic-scholar'
  sourceId: string
  externalUrl: string
}

type InviteForm = {
  targetEmail: string
  note: string
  maxUses: string
  expiresInDays: string
}

const emptyPaperForm: PaperForm = {
  title: '',
  bibtex: '',
  abstract: '',
  introduction: '',
  tldr: '',
  authorsText: '',
  year: '',
  venue: '',
  source: 'manual',
  sourceId: '',
  externalUrl: '',
}

const emptyInviteForm: InviteForm = {
  targetEmail: '',
  note: '',
  maxUses: '1',
  expiresInDays: '14',
}

function App() {
  const [session, setSession] = useState<SessionPayload>({
    user: null,
    features: emptyFeatures,
    stats: { ownPaperCount: 0, networkPaperCount: 0 },
  })
  const [papers, setPapers] = useState<PaperRecord[]>([])
  const [invites, setInvites] = useState<InviteRecord[]>([])
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    name: '',
    researchSummary: '',
    bio: '',
  })
  const [paperForm, setPaperForm] = useState<PaperForm>(emptyPaperForm)
  const [inviteForm, setInviteForm] = useState<InviteForm>(emptyInviteForm)
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null)
  const [authInviteCode, setAuthInviteCode] = useState('')
  const [importSource, setImportSource] = useState<'dblp' | 'semantic-scholar'>('dblp')
  const [importQuery, setImportQuery] = useState('')
  const [importResults, setImportResults] = useState<ImportResult[]>([])
  const [recommendationExtra, setRecommendationExtra] = useState('')
  const [recommendations, setRecommendations] = useState<RecommendationPayload | null>(null)
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const url = new URL(window.location.href)
    const authError = url.searchParams.get('authError')
    if (authError) {
      setNotice(decodeURIComponent(authError))
      url.searchParams.delete('authError')
      window.history.replaceState({}, '', url.toString())
    }
    void refreshSession()
  }, [])

  const isAuthenticated = Boolean(session.user)

  const providerButtons = useMemo(
    () => [
      {
        provider: 'github' as const,
        label: 'GitHub 登录',
        enabled: session.features.githubAuth,
      },
      {
        provider: 'google' as const,
        label: 'Google 登录',
        enabled: session.features.googleAuth,
      },
    ],
    [session.features.githubAuth, session.features.googleAuth],
  )

  async function refreshSession() {
    setLoadingLabel('正在加载会话')
    try {
      const nextSession = await api<SessionPayload>('/api/session')
      setSession(nextSession)
      if (nextSession.user) {
        setProfileForm({
          name: nextSession.user.name,
          researchSummary: nextSession.user.researchSummary,
          bio: nextSession.user.bio,
        })
        const [paperList, inviteList] = await Promise.all([
          api<PaperRecord[]>('/api/papers'),
          api<InviteRecord[]>('/api/invites'),
        ])
        setPapers(paperList)
        setInvites(inviteList)
      } else {
        setPapers([])
        setInvites([])
      }
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  async function startAuth(provider: AuthProvider) {
    setLoadingLabel(`正在跳转 ${provider}`)
    try {
      const response = await api<{ url: string }>(`/api/auth/start/${provider}`, {
        method: 'POST',
        body: JSON.stringify({ inviteCode: authInviteCode.trim() }),
      })
      window.location.href = response.url
    } catch (error) {
      setLoadingLabel(null)
      setNotice(readError(error))
    }
  }

  async function logout() {
    setLoadingLabel('正在退出登录')
    try {
      await api('/api/auth/logout', { method: 'POST' })
      setRecommendations(null)
      setPaperForm(emptyPaperForm)
      setEditingPaperId(null)
      await refreshSession()
    } catch (error) {
      setNotice(readError(error))
      setLoadingLabel(null)
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在保存研究简介')
    try {
      await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify(profileForm),
      })
      await refreshSession()
      setNotice('研究简介已保存')
    } catch (error) {
      setNotice(readError(error))
      setLoadingLabel(null)
    }
  }

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在生成邀请码')
    try {
      const result = await api<InviteRecord>('/api/invites', {
        method: 'POST',
        body: JSON.stringify({
          targetEmail: inviteForm.targetEmail,
          note: inviteForm.note,
          maxUses: Number(inviteForm.maxUses || 1),
          expiresInDays: Number(inviteForm.expiresInDays || 14),
        }),
      })
      setInviteForm(emptyInviteForm)
      setInvites((current) => [result, ...current])
      setNotice(`邀请码已生成：${result.code}`)
      await copyText(result.code)
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  async function searchImports(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!importQuery.trim()) {
      setNotice('请先输入检索关键词')
      return
    }
    setLoadingLabel(`正在从 ${importSource} 导入`)
    try {
      const query = new URLSearchParams({ q: importQuery.trim() }).toString()
      const result = await api<ImportResult[]>(`/api/import/${importSource}?${query}`)
      setImportResults(result)
      if (!result.length) {
        setNotice('没有找到可导入的结果')
      }
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  function applyImport(result: ImportResult) {
    setEditingPaperId(null)
    setPaperForm({
      title: result.title,
      bibtex: result.bibtex,
      abstract: result.abstract,
      introduction: result.introduction,
      tldr: result.tldr,
      authorsText: result.authors.join(', '),
      year: result.year ? String(result.year) : '',
      venue: result.venue,
      source: result.source,
      sourceId: result.sourceId ?? '',
      externalUrl: result.externalUrl ?? '',
    })
    setNotice('已将导入结果填入表单，请检查后保存')
  }

  function editPaper(paper: PaperRecord) {
    setEditingPaperId(paper.id)
    setPaperForm({
      title: paper.title,
      bibtex: paper.bibtex,
      abstract: paper.abstract,
      introduction: paper.introduction,
      tldr: paper.tldr,
      authorsText: paper.authors.join(', '),
      year: paper.year ? String(paper.year) : '',
      venue: paper.venue,
      source: paper.source,
      sourceId: paper.sourceId ?? '',
      externalUrl: paper.externalUrl ?? '',
    })
  }

  async function submitPaper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel(editingPaperId ? '正在更新论文' : '正在保存论文')
    try {
      const payload = {
        title: paperForm.title,
        bibtex: paperForm.bibtex,
        abstract: paperForm.abstract,
        introduction: paperForm.introduction,
        tldr: paperForm.tldr,
        authors: paperForm.authorsText
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        year: paperForm.year ? Number(paperForm.year) : null,
        venue: paperForm.venue,
        source: paperForm.source,
        sourceId: paperForm.sourceId || null,
        externalUrl: paperForm.externalUrl || null,
      }
      const endpoint = editingPaperId ? `/api/papers/${editingPaperId}` : '/api/papers'
      const method = editingPaperId ? 'PUT' : 'POST'
      const result = await api<PaperRecord>(endpoint, {
        method,
        body: JSON.stringify(payload),
      })
      setPapers((current) => {
        if (editingPaperId) {
          return current.map((paper) => (paper.id === result.id ? result : paper))
        }
        return [result, ...current]
      })
      setPaperForm(emptyPaperForm)
      setEditingPaperId(null)
      await refreshSession()
      setNotice(editingPaperId ? '论文已更新' : '论文已保存')
    } catch (error) {
      setNotice(readError(error))
      setLoadingLabel(null)
    }
  }

  async function removePaper(paperId: string) {
    if (!window.confirm('确认删除这篇论文吗？')) {
      return
    }
    setLoadingLabel('正在删除论文')
    try {
      await api(`/api/papers/${paperId}`, { method: 'DELETE' })
      setPapers((current) => current.filter((paper) => paper.id !== paperId))
      if (editingPaperId === paperId) {
        setEditingPaperId(null)
        setPaperForm(emptyPaperForm)
      }
      await refreshSession()
      setNotice('论文已删除')
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  async function generateRecommendations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在分析研究方向并检索候选文献')
    try {
      const result = await api<RecommendationPayload>('/api/recommendations', {
        method: 'POST',
        body: JSON.stringify({ extraContext: recommendationExtra }),
      })
      setRecommendations(result)
      setNotice(result.recommendations.length ? '已生成候选引用' : '目前还没有匹配到其他用户论文')
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  return (
    <div className="shell">
      <div className="aurora aurora-a" />
      <div className="aurora aurora-b" />
      <main className="page">
        <section className="hero card">
          <div>
            <p className="eyebrow">We Cites</p>
            <h1>邀请制研究者引用发现站</h1>
            <p className="lead">
              用户填写自己的研究工作与简介后，系统先抽取研究方面，再从站内论文库中给出可直接复制
              BibTeX 的前 20 个候选引用。
            </p>
          </div>
          <div className="hero-stats">
            <Metric label="我的论文" value={String(session.stats.ownPaperCount)} />
            <Metric label="他人论文" value={String(session.stats.networkPaperCount)} />
            <Metric label="LLM 分析" value={session.features.aiAnalysis ? '已开启' : '降级模式'} />
          </div>
        </section>

        {notice ? <div className="notice">{notice}</div> : null}
        {loadingLabel ? <div className="loading">{loadingLabel}...</div> : null}

        {!isAuthenticated ? (
          <section className="auth-grid">
            <article className="card auth-card">
              <h2>邀请制注册 / 登录</h2>
              <p>
                新用户先输入邀请码，再走 GitHub 或 Google OAuth。老用户直接点对应登录按钮即可。
              </p>
              <label>
                邀请码
                <input
                  value={authInviteCode}
                  onChange={(event) => setAuthInviteCode(event.target.value)}
                  placeholder="例如 INV-4F7D2A91"
                />
              </label>
              <div className="button-row">
                {providerButtons.map((item) => (
                  <button
                    key={item.provider}
                    type="button"
                    disabled={!item.enabled}
                    onClick={() => void startAuth(item.provider)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="muted">
                首个管理员通过环境变量 `BOOTSTRAP_ADMIN_EMAILS` 放行。当前仓库默认预期邮箱是
                `sci.m.wang@gmail.com`。
              </p>
            </article>

            <article className="card auth-card">
              <h2>当前能力</h2>
              <ul className="plain-list">
                <li>邀请制注册，老用户可生成新邀请码</li>
                <li>GitHub / Google OAuth，且仍受邀请码约束</li>
                <li>论文手动录入：title、bibtex、摘要、TLDR、介绍</li>
                <li>DBLP / Semantic Scholar 快速导入后再手动补全</li>
                <li>推荐结果标注命中的研究方面，并可直接复制 BibTeX</li>
              </ul>
            </article>
          </section>
        ) : (
          <>
            <section className="dashboard-header card">
              <div>
                <p className="eyebrow">已登录</p>
                <h2>{session.user?.name}</h2>
                <p className="muted">
                  {session.user?.email} · {session.user?.role === 'owner' ? 'Owner' : 'Member'}
                </p>
              </div>
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => void logout()}>
                  退出登录
                </button>
              </div>
            </section>

            <section className="grid two-col">
              <article className="card section-card">
                <h2>研究简介</h2>
                <form className="form-grid" onSubmit={saveProfile}>
                  <label>
                    显示名称
                    <input
                      value={profileForm.name}
                      onChange={(event) =>
                        setProfileForm((current) => ({ ...current, name: event.target.value }))
                      }
                      placeholder="例如 Ming Wang"
                    />
                  </label>
                  <label>
                    研究工作
                    <textarea
                      rows={6}
                      value={profileForm.researchSummary}
                      onChange={(event) =>
                        setProfileForm((current) => ({
                          ...current,
                          researchSummary: event.target.value,
                        }))
                      }
                      placeholder="描述你的研究主题、方法、任务、场景与关键词。"
                    />
                  </label>
                  <label>
                    个人简介
                    <textarea
                      rows={4}
                      value={profileForm.bio}
                      onChange={(event) =>
                        setProfileForm((current) => ({ ...current, bio: event.target.value }))
                      }
                      placeholder="介绍你的研究背景、目标和当前问题。"
                    />
                  </label>
                  <button type="submit">保存简介</button>
                </form>
              </article>

              <article className="card section-card">
                <h2>邀请码管理</h2>
                <form className="form-grid compact" onSubmit={createInvite}>
                  <label>
                    定向邮箱（可选）
                    <input
                      value={inviteForm.targetEmail}
                      onChange={(event) =>
                        setInviteForm((current) => ({ ...current, targetEmail: event.target.value }))
                      }
                      placeholder="someone@example.com"
                    />
                  </label>
                  <label>
                    备注
                    <input
                      value={inviteForm.note}
                      onChange={(event) =>
                        setInviteForm((current) => ({ ...current, note: event.target.value }))
                      }
                      placeholder="例如 lab student"
                    />
                  </label>
                  <label>
                    最大使用次数
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={inviteForm.maxUses}
                      onChange={(event) =>
                        setInviteForm((current) => ({ ...current, maxUses: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    过期天数
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={inviteForm.expiresInDays}
                      onChange={(event) =>
                        setInviteForm((current) => ({
                          ...current,
                          expiresInDays: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <button type="submit">生成邀请码</button>
                </form>
                <div className="list-stack">
                  {invites.length ? (
                    invites.map((invite) => (
                      <div className="list-card" key={invite.id}>
                        <div>
                          <strong>{invite.code}</strong>
                          <p className="muted">
                            已用 {invite.usedCount}/{invite.maxUses}
                            {invite.targetEmail ? ` · ${invite.targetEmail}` : ''}
                            {invite.note ? ` · ${invite.note}` : ''}
                          </p>
                        </div>
                        <button type="button" className="secondary" onClick={() => void copyText(invite.code)}>
                          复制
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted">你还没有生成邀请码。</p>
                  )}
                </div>
              </article>
            </section>

            <section className="grid two-col">
              <article className="card section-card">
                <h2>论文导入</h2>
                <form className="inline-form" onSubmit={searchImports}>
                  <select
                    value={importSource}
                    onChange={(event) =>
                      setImportSource(event.target.value as 'dblp' | 'semantic-scholar')
                    }
                  >
                    <option value="dblp">DBLP</option>
                    <option value="semantic-scholar">Semantic Scholar</option>
                  </select>
                  <input
                    value={importQuery}
                    onChange={(event) => setImportQuery(event.target.value)}
                    placeholder="输入 title / author / topic"
                  />
                  <button type="submit">搜索导入</button>
                </form>
                <div className="list-stack import-results">
                  {importResults.map((result, index) => (
                    <div className="list-card vertical" key={`${result.source}-${result.sourceId ?? index}`}>
                      <div>
                        <strong>{result.title}</strong>
                        <p className="muted">
                          {result.authors.join(', ') || 'Unknown authors'}
                          {result.year ? ` · ${result.year}` : ''}
                          {result.venue ? ` · ${result.venue}` : ''}
                        </p>
                        {result.abstract ? <p>{result.abstract}</p> : null}
                      </div>
                      <div className="button-row">
                        <button type="button" className="secondary" onClick={() => applyImport(result)}>
                          填入表单
                        </button>
                        {result.externalUrl ? (
                          <a className="link-button" href={result.externalUrl} target="_blank" rel="noreferrer">
                            查看来源
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="card section-card">
                <h2>{editingPaperId ? '编辑论文' : '上传论文信息'}</h2>
                <form className="form-grid" onSubmit={submitPaper}>
                  <label>
                    Title
                    <input
                      value={paperForm.title}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, title: event.target.value }))
                      }
                      placeholder="Paper title"
                    />
                  </label>
                  <label>
                    BibTeX
                    <textarea
                      rows={8}
                      value={paperForm.bibtex}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, bibtex: event.target.value }))
                      }
                      placeholder="@article{...}"
                    />
                  </label>
                  <label>
                    Authors
                    <input
                      value={paperForm.authorsText}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, authorsText: event.target.value }))
                      }
                      placeholder="Alice, Bob, Carol"
                    />
                  </label>
                  <div className="split-grid">
                    <label>
                      Year
                      <input
                        type="number"
                        value={paperForm.year}
                        onChange={(event) =>
                          setPaperForm((current) => ({ ...current, year: event.target.value }))
                        }
                        placeholder="2026"
                      />
                    </label>
                    <label>
                      Venue
                      <input
                        value={paperForm.venue}
                        onChange={(event) =>
                          setPaperForm((current) => ({ ...current, venue: event.target.value }))
                        }
                        placeholder="NeurIPS / ACL / arXiv"
                      />
                    </label>
                  </div>
                  <label>
                    Abstract
                    <textarea
                      rows={5}
                      value={paperForm.abstract}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, abstract: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    TLDR
                    <textarea
                      rows={3}
                      value={paperForm.tldr}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, tldr: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    介绍 / 适用场景
                    <textarea
                      rows={4}
                      value={paperForm.introduction}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, introduction: event.target.value }))
                      }
                      placeholder="简要说明论文解决的问题、核心方法和适用场景。"
                    />
                  </label>
                  <div className="split-grid">
                    <label>
                      来源
                      <select
                        value={paperForm.source}
                        onChange={(event) =>
                          setPaperForm((current) => ({
                            ...current,
                            source: event.target.value as PaperForm['source'],
                          }))
                        }
                      >
                        <option value="manual">manual</option>
                        <option value="dblp">dblp</option>
                        <option value="semantic-scholar">semantic-scholar</option>
                      </select>
                    </label>
                    <label>
                      来源 ID
                      <input
                        value={paperForm.sourceId}
                        onChange={(event) =>
                          setPaperForm((current) => ({ ...current, sourceId: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label>
                    外部链接
                    <input
                      value={paperForm.externalUrl}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, externalUrl: event.target.value }))
                      }
                      placeholder="https://..."
                    />
                  </label>
                  <div className="button-row">
                    <button type="submit">{editingPaperId ? '更新论文' : '保存论文'}</button>
                    {editingPaperId ? (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setEditingPaperId(null)
                          setPaperForm(emptyPaperForm)
                        }}
                      >
                        取消编辑
                      </button>
                    ) : null}
                  </div>
                </form>
              </article>
            </section>

            <section className="card section-card">
              <h2>我的论文</h2>
              <div className="list-stack">
                {papers.length ? (
                  papers.map((paper) => (
                    <div className="list-card vertical" key={paper.id}>
                      <div>
                        <strong>{paper.title}</strong>
                        <p className="muted">
                          {paper.authors.join(', ') || 'Unknown authors'}
                          {paper.year ? ` · ${paper.year}` : ''}
                          {paper.venue ? ` · ${paper.venue}` : ''}
                        </p>
                        {paper.tldr ? <p>{paper.tldr}</p> : null}
                      </div>
                      <div className="button-row">
                        <button type="button" className="secondary" onClick={() => editPaper(paper)}>
                          编辑
                        </button>
                        <button type="button" className="secondary" onClick={() => void copyText(paper.bibtex)}>
                          复制 BibTeX
                        </button>
                        <button type="button" className="danger" onClick={() => void removePaper(paper.id)}>
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="muted">还没有上传论文，可以先手动填写或从 DBLP / Semantic Scholar 导入。</p>
                )}
              </div>
            </section>

            <section className="card section-card">
              <h2>推荐引用</h2>
              <form className="form-grid" onSubmit={generateRecommendations}>
                <label>
                  补充检索说明（可选）
                  <textarea
                    rows={4}
                    value={recommendationExtra}
                    onChange={(event) => setRecommendationExtra(event.target.value)}
                    placeholder="例如：我现在重点想补 related work 里关于 long-context reasoning 和 scientific retrieval 的引用。"
                  />
                </label>
                <button type="submit">生成候选引用</button>
              </form>

              {recommendations ? (
                <div className="recommendation-panel">
                  <div className="aspect-row">
                    {recommendations.aspects.map((aspect) => (
                      <div className="aspect-chip" key={aspect.label}>
                        <strong>{aspect.label}</strong>
                        <span>{aspect.keywords.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                  <div className="list-stack">
                    {recommendations.recommendations.map((item) => (
                      <div className="list-card vertical" key={item.paper.id}>
                        <div>
                          <strong>{item.paper.title}</strong>
                          <p className="muted">
                            {item.paper.ownerName ? `来自 ${item.paper.ownerName} · ` : ''}
                            {item.paper.authors.join(', ') || 'Unknown authors'}
                            {item.paper.year ? ` · ${item.paper.year}` : ''}
                            {item.paper.venue ? ` · ${item.paper.venue}` : ''}
                          </p>
                          <div className="tag-row">
                            {item.matchedAspects.map((aspect) => (
                              <span className="tag" key={aspect}>
                                {aspect}
                              </span>
                            ))}
                          </div>
                          {item.paper.tldr ? <p>{item.paper.tldr}</p> : null}
                          <p className="muted">{item.reason}</p>
                        </div>
                        <div className="button-row">
                          <button type="button" className="secondary" onClick={() => void copyText(item.paper.bibtex)}>
                            复制 BibTeX
                          </button>
                          {item.paper.externalUrl ? (
                            <a className="link-button" href={item.paper.externalUrl} target="_blank" rel="noreferrer">
                              查看来源
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="muted">
                  系统会先分析你的研究方面，再从其他用户上传的论文中给出前 20 个候选引用。
                </p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    let message = `Request failed: ${response.status}`
    try {
      const payload = (await response.json()) as ApiError
      if (payload.error) {
        message = payload.error
      }
    } catch {
      message = await response.text()
    }
    throw new Error(message)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

function readError(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return '发生了未知错误'
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}

export default App

import { useEffect, useState, type FormEvent } from 'react'
import type {
  ApiError,
  InviteRecord,
  PaperRecord,
  RecommendationPayload,
  SessionPayload,
} from './lib/shared'
import { emptyFeatures } from './lib/shared'

type DashboardPage = 'profile' | 'papers' | 'invites' | 'recommendations'

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
}

type InviteForm = {
  targetEmail: string
  note: string
  maxUses: string
  expiresInDays: string
}

type LoginForm = {
  email: string
  password: string
}

type RegisterForm = {
  name: string
  email: string
  password: string
  inviteCode: string
}

const emptyPaperForm: PaperForm = {
  title: '',
  bibtex: '',
  abstract: '',
  introduction: '',
  tldr: '',
}

const emptyInviteForm: InviteForm = {
  targetEmail: '',
  note: '',
  maxUses: '1',
  expiresInDays: '14',
}

const emptyLoginForm: LoginForm = {
  email: '',
  password: '',
}

const emptyRegisterForm: RegisterForm = {
  name: '',
  email: '',
  password: '',
  inviteCode: '',
}

const dashboardPages: Array<{ id: DashboardPage; label: string }> = [
  { id: 'profile', label: '研究资料' },
  { id: 'papers', label: '论文库' },
  { id: 'invites', label: '邀请码' },
  { id: 'recommendations', label: '推荐引用' },
]

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
  const [loginForm, setLoginForm] = useState<LoginForm>(emptyLoginForm)
  const [registerForm, setRegisterForm] = useState<RegisterForm>(emptyRegisterForm)
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null)
  const [recommendationExtra, setRecommendationExtra] = useState('')
  const [recommendations, setRecommendations] = useState<RecommendationPayload | null>(null)
  const [loadingLabel, setLoadingLabel] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState<DashboardPage>(() => readDashboardPage())

  useEffect(() => {
    const url = new URL(window.location.href)
    const authError = url.searchParams.get('authError')
    if (authError) {
      setNotice(decodeURIComponent(authError))
      url.searchParams.delete('authError')
      window.history.replaceState({}, '', url.toString())
    }

    const onHashChange = () => setCurrentPage(readDashboardPage())
    window.addEventListener('hashchange', onHashChange)
    void refreshSession()

    return () => {
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  const isAuthenticated = Boolean(session.user)

  useEffect(() => {
    if (!isAuthenticated) {
      return
    }
    if (!window.location.hash) {
      navigateToPage('profile', true)
    }
  }, [isAuthenticated])

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

  function navigateToPage(page: DashboardPage, replace = false) {
    setCurrentPage(page)
    const url = new URL(window.location.href)
    url.hash = page
    if (replace) {
      window.history.replaceState({}, '', url.toString())
      return
    }
    window.history.pushState({}, '', url.toString())
  }

  async function loginWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在登录')
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginForm),
      })
      setLoginForm(emptyLoginForm)
      await refreshSession()
      navigateToPage('profile', true)
      setNotice('登录成功')
    } catch (error) {
      setLoadingLabel(null)
      setNotice(readError(error))
    }
  }

  async function registerWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在创建账号')
    try {
      await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(registerForm),
      })
      setRegisterForm(emptyRegisterForm)
      await refreshSession()
      navigateToPage('profile', true)
      setNotice('账号已创建并登录')
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
      const url = new URL(window.location.href)
      url.hash = ''
      window.history.replaceState({}, '', url.toString())
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
      await copyText(result.code)
      setNotice(`邀请码已生成并复制：${result.code}`)
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  function editPaper(paper: PaperRecord) {
    setEditingPaperId(paper.id)
    setPaperForm({
      title: paper.title,
      bibtex: paper.bibtex,
      abstract: paper.abstract,
      introduction: paper.introduction,
      tldr: paper.tldr,
    })
    navigateToPage('papers')
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
            <h1>研究者之间的小型引用网络</h1>
            <p className="lead">维护研究资料、论文条目和站内候选引用，不把所有流程堆在同一页。</p>
          </div>
          <div className="hero-stats">
            <Metric label="我的论文" value={String(session.stats.ownPaperCount)} />
            <Metric label="网络论文" value={String(session.stats.networkPaperCount)} />
            <Metric label="推荐引擎" value={session.features.aiAnalysis ? 'AI + 向量' : '降级模式'} />
          </div>
        </section>

        {notice ? <div className="notice">{notice}</div> : null}
        {loadingLabel ? <div className="loading">{loadingLabel}...</div> : null}

        {!isAuthenticated ? (
          <section className="auth-grid">
            <article className="card auth-card">
              <h2>邮箱登录</h2>
              <form className="form-grid compact" onSubmit={loginWithEmail}>
                <label>
                  邮箱
                  <input
                    type="email"
                    autoComplete="email"
                    value={loginForm.email}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="you@example.com"
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={loginForm.password}
                    onChange={(event) =>
                      setLoginForm((current) => ({ ...current, password: event.target.value }))
                    }
                    placeholder="至少 8 位"
                  />
                </label>
                <button type="submit">登录</button>
              </form>
            </article>

            <article className="card auth-card">
              <h2>创建账号</h2>
              <form className="form-grid compact" onSubmit={registerWithEmail}>
                <label>
                  显示名称
                  <input
                    autoComplete="name"
                    value={registerForm.name}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="例如 Ming Wang"
                  />
                </label>
                <label>
                  邮箱
                  <input
                    type="email"
                    autoComplete="email"
                    value={registerForm.email}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, email: event.target.value }))
                    }
                    placeholder="you@example.com"
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={registerForm.password}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, password: event.target.value }))
                    }
                    placeholder="至少 8 位"
                  />
                </label>
                <label>
                  邀请码
                  <input
                    value={registerForm.inviteCode}
                    onChange={(event) =>
                      setRegisterForm((current) => ({ ...current, inviteCode: event.target.value }))
                    }
                    placeholder="普通成员注册需要填写"
                  />
                </label>
                <button type="submit">创建账号</button>
              </form>
              <p className="muted">初始管理员白名单邮箱可直接注册，其他新用户需要邀请码。</p>
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

            <nav className="page-tabs card">
              {dashboardPages.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  className={currentPage === page.id ? 'tab-button active' : 'tab-button'}
                  onClick={() => navigateToPage(page.id)}
                >
                  {page.label}
                </button>
              ))}
            </nav>

            {currentPage === 'profile' ? (
              <section className="grid two-col">
                <article className="card section-card">
                  <h2>研究资料</h2>
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
                    <button type="submit">保存资料</button>
                  </form>
                </article>

                <article className="card section-card">
                  <h2>当前状态</h2>
                  <div className="list-stack">
                    <div className="list-card vertical">
                      <strong>站内候选来源</strong>
                      <p className="muted">当前推荐只会从其他用户已上传的论文条目里选候选引用。</p>
                    </div>
                    <div className="list-card vertical">
                      <strong>推荐方式</strong>
                      <p className="muted">
                        {session.features.aiAnalysis
                          ? '当前使用 AI 抽取研究方面，再结合向量相似度做候选排序。'
                          : '当前未启用外部 AI，系统会回退到关键词和轻量向量匹配。'}
                      </p>
                    </div>
                    <div className="list-card vertical">
                      <strong>账号规则</strong>
                      <p className="muted">你可以生成邀请码给其他成员，形成一个小范围的站内引用网络。</p>
                    </div>
                  </div>
                </article>
              </section>
            ) : null}

            {currentPage === 'papers' ? (
              <section className="grid two-col">
                <article className="card section-card">
                  <h2>{editingPaperId ? '编辑论文' : '添加论文'}</h2>
                  <form className="form-grid" onSubmit={submitPaper}>
                    <label>
                      Title
                      <input
                        value={paperForm.title}
                        onChange={(event) =>
                          setPaperForm((current) => ({ ...current, title: event.target.value }))
                        }
                        placeholder="可填写；若留空则尝试从 BibTeX 提取"
                      />
                    </label>
                    <label>
                      BibTeX
                      <textarea
                        rows={10}
                        value={paperForm.bibtex}
                        onChange={(event) =>
                          setPaperForm((current) => ({ ...current, bibtex: event.target.value }))
                        }
                        placeholder="@article{...}"
                      />
                    </label>
                    <p className="muted">作者、年份、venue、链接等元数据会从 BibTeX 自动解析，不需要单独填写。</p>
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

                <article className="card section-card">
                  <h2>我的论文</h2>
                  <div className="list-stack">
                    {papers.length ? (
                      papers.map((paper) => (
                        <div className="list-card vertical" key={paper.id}>
                          <div>
                            <strong>{paper.title}</strong>
                            <p className="muted">
                              {paper.authors.join(', ') || '作者将从 BibTeX 解析'}
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
                            {paper.externalUrl ? (
                              <a className="link-button" href={paper.externalUrl} target="_blank" rel="noreferrer">
                                查看链接
                              </a>
                            ) : null}
                            <button type="button" className="danger" onClick={() => void removePaper(paper.id)}>
                              删除
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted">当前先只支持手动录入 BibTeX 与摘要信息。</p>
                    )}
                  </div>
                </article>
              </section>
            ) : null}

            {currentPage === 'invites' ? (
              <section className="grid two-col">
                <article className="card section-card">
                  <h2>生成邀请码</h2>
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
                          setInviteForm((current) => ({ ...current, expiresInDays: event.target.value }))
                        }
                      />
                    </label>
                    <button type="submit">生成邀请码</button>
                  </form>
                </article>

                <article className="card section-card">
                  <h2>已生成的邀请码</h2>
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
            ) : null}

            {currentPage === 'recommendations' ? (
              <section className="card section-card">
                <h2>推荐引用</h2>
                <form className="form-grid" onSubmit={generateRecommendations}>
                  <label>
                    补充检索说明（可选）
                    <textarea
                      rows={4}
                      value={recommendationExtra}
                      onChange={(event) => setRecommendationExtra(event.target.value)}
                      placeholder="例如当前正在补 related work，优先找方法接近、任务相邻的工作。"
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
                  <p className="muted">系统会根据你的研究资料，从其他用户上传的论文中挑选候选引用。</p>
                )}
              </section>
            ) : null}
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

function readDashboardPage(): DashboardPage {
  if (typeof window === 'undefined') {
    return 'profile'
  }
  const page = window.location.hash.replace(/^#/, '')
  if (page === 'profile' || page === 'papers' || page === 'invites' || page === 'recommendations') {
    return page
  }
  return 'profile'
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

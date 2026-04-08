import { startTransition, useEffect, useState, type FormEvent } from 'react'
import type {
  ApiError,
  InviteRecord,
  PaperRecord,
  RecommendationPayload,
  SessionPayload,
  UserSummary,
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

type PageMeta = {
  nav: string
  title: string
  description: string
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

const pageMeta: Record<DashboardPage, PageMeta> = {
  profile: {
    nav: '研究资料',
    title: '更新研究资料',
    description: '聚焦你的研究问题、方法和场景，让站内匹配更准确。',
  },
  papers: {
    nav: '论文库',
    title: '管理论文条目',
    description: '提交 BibTeX、摘要和简述，作者与 venue 会自动提取。',
  },
  invites: {
    nav: '邀请码',
    title: '管理邀请范围',
    description: '控制谁可以进入你的研究者网络，并按需限制邮箱和次数。',
  },
  recommendations: {
    nav: '推荐引用',
    title: '查看站内候选引用',
    description: '从其他成员上传的论文中筛出与你当前方向更接近的候选条目。',
  },
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

  const isAuthenticated = Boolean(session.user)
  const activePageMeta = pageMeta[currentPage]

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

  useEffect(() => {
    if (!isAuthenticated) {
      return
    }
    if (!window.location.hash) {
      navigateToPage('profile')
    }
  }, [isAuthenticated])

  async function refreshSession(showLoading = true) {
    if (showLoading) {
      setLoadingLabel('正在加载会话')
    }

    try {
      const nextSession = await api<SessionPayload>('/api/session')
      if (!nextSession.user) {
        startTransition(() => {
          setSession(nextSession)
          setPapers([])
          setInvites([])
          setRecommendations(null)
          setEditingPaperId(null)
          setPaperForm(emptyPaperForm)
        })
        return
      }

      const [paperList, inviteList] = await Promise.all([
        api<PaperRecord[]>('/api/papers'),
        api<InviteRecord[]>('/api/invites'),
      ])

      startTransition(() => {
        setSession(nextSession)
        setProfileForm({
          name: nextSession.user!.name,
          researchSummary: nextSession.user!.researchSummary,
          bio: nextSession.user!.bio,
        })
        setPapers(paperList)
        setInvites(inviteList)
      })
    } catch (error) {
      setNotice(readError(error))
    } finally {
      if (showLoading) {
        setLoadingLabel(null)
      }
    }
  }

  function navigateToPage(page: DashboardPage) {
    if (currentPage === page) {
      return
    }
    startTransition(() => setCurrentPage(page))
    const url = new URL(window.location.href)
    url.hash = page
    window.history.replaceState({}, '', url.toString())
  }

  function updateSessionUser(updater: (user: UserSummary) => UserSummary) {
    startTransition(() => {
      setSession((current) => {
        if (!current.user) {
          return current
        }
        return { ...current, user: updater(current.user) }
      })
    })
  }

  function adjustOwnPaperCount(delta: number) {
    startTransition(() => {
      setSession((current) => ({
        ...current,
        stats: {
          ...current.stats,
          ownPaperCount: Math.max(0, current.stats.ownPaperCount + delta),
        },
      }))
    })
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
      await refreshSession(false)
      navigateToPage('profile')
      setNotice('登录成功')
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
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
      await refreshSession(false)
      navigateToPage('profile')
      setNotice('账号已创建并登录')
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  async function logout() {
    setLoadingLabel('正在退出登录')
    try {
      await api('/api/auth/logout', { method: 'POST' })
      const url = new URL(window.location.href)
      url.hash = ''
      window.history.replaceState({}, '', url.toString())
      startTransition(() => {
        setSession({
          user: null,
          features: session.features,
          stats: { ownPaperCount: 0, networkPaperCount: 0 },
        })
        setPapers([])
        setInvites([])
        setRecommendations(null)
        setEditingPaperId(null)
        setPaperForm(emptyPaperForm)
        setCurrentPage('profile')
      })
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在保存资料')
    try {
      await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify(profileForm),
      })
      updateSessionUser((user) => ({
        ...user,
        name: profileForm.name.trim() || user.name,
        researchSummary: profileForm.researchSummary,
        bio: profileForm.bio,
      }))
      setNotice('研究资料已保存')
    } catch (error) {
      setNotice(readError(error))
    } finally {
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

      startTransition(() => {
        setInviteForm(emptyInviteForm)
        setInvites((current) => [result, ...current])
      })

      try {
        await copyText(result.code)
        setNotice(`邀请码已生成并复制：${result.code}`)
      } catch {
        setNotice(`邀请码已生成：${result.code}`)
      }
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  function editPaper(paper: PaperRecord) {
    startTransition(() => {
      setEditingPaperId(paper.id)
      setPaperForm({
        title: paper.title,
        bibtex: paper.bibtex,
        abstract: paper.abstract,
        introduction: paper.introduction,
        tldr: paper.tldr,
      })
    })
    navigateToPage('papers')
  }

  async function submitPaper(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel(editingPaperId ? '正在更新论文' : '正在保存论文')
    const isEditing = Boolean(editingPaperId)

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

      startTransition(() => {
        setPapers((current) => {
          if (isEditing) {
            return current.map((paper) => (paper.id === result.id ? result : paper))
          }
          return [result, ...current]
        })
        setPaperForm(emptyPaperForm)
        setEditingPaperId(null)
      })

      if (!isEditing) {
        adjustOwnPaperCount(1)
      }
      setNotice(isEditing ? '论文已更新' : '论文已保存')
    } catch (error) {
      setNotice(readError(error))
    } finally {
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
      startTransition(() => {
        setPapers((current) => current.filter((paper) => paper.id !== paperId))
        if (editingPaperId === paperId) {
          setEditingPaperId(null)
          setPaperForm(emptyPaperForm)
        }
      })
      adjustOwnPaperCount(-1)
      setNotice('论文已删除')
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  async function generateRecommendations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoadingLabel('正在生成候选引用')
    try {
      const result = await api<RecommendationPayload>('/api/recommendations', {
        method: 'POST',
        body: JSON.stringify({ extraContext: recommendationExtra }),
      })
      startTransition(() => setRecommendations(result))
      setNotice(result.recommendations.length ? '已生成候选引用' : '目前还没有匹配到其他用户论文')
    } catch (error) {
      setNotice(readError(error))
    } finally {
      setLoadingLabel(null)
    }
  }

  return isAuthenticated ? (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">WC</div>
          <div>
            <p className="eyebrow">We Cites</p>
            <strong className="sidebar-title">Research Network</strong>
          </div>
        </div>

        <div className="sidebar-user surface surface-muted">
          <div className="avatar-pill">{initialsOf(session.user?.name)}</div>
          <div>
            <strong>{session.user?.name}</strong>
            <p className="muted compact-line">{session.user?.email}</p>
            <p className="muted compact-line">{session.user?.role === 'owner' ? 'Owner' : 'Member'}</p>
          </div>
        </div>

        <div className="sidebar-metrics">
          <MetricCard label="我的论文" value={String(session.stats.ownPaperCount)} />
          <MetricCard label="网络论文" value={String(session.stats.networkPaperCount)} />
          <MetricCard label="邀请码" value={String(invites.length)} />
        </div>

        <nav className="sidebar-nav">
          {dashboardPages.map((page) => (
            <button
              key={page.id}
              type="button"
              className={currentPage === page.id ? 'nav-button active' : 'nav-button'}
              onClick={() => navigateToPage(page.id)}
            >
              {page.label}
            </button>
          ))}
        </nav>

        <button type="button" className="secondary sidebar-logout" onClick={() => void logout()}>
          退出登录
        </button>
      </aside>

      <section className="workspace">
        <div className="workspace-frame">
          {notice ? <Banner tone="info" text={notice} /> : null}
          {loadingLabel ? <Banner tone="loading" text={loadingLabel} /> : null}

          <header className="workspace-header">
            <div>
              <p className="eyebrow">{activePageMeta.nav}</p>
              <h1 className="workspace-title">{activePageMeta.title}</h1>
              <p className="workspace-copy">{activePageMeta.description}</p>
            </div>
            {currentPage === 'papers' && editingPaperId ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditingPaperId(null)
                  setPaperForm(emptyPaperForm)
                }}
              >
                结束编辑
              </button>
            ) : null}
          </header>

          {currentPage === 'profile' ? (
            <div className="content-grid profile-grid">
              <article className="surface panel-form">
                <SectionTitle title="研究资料" note="这里的内容会用于站内论文推荐。" />
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
                      rows={7}
                      value={profileForm.researchSummary}
                      onChange={(event) =>
                        setProfileForm((current) => ({ ...current, researchSummary: event.target.value }))
                      }
                      placeholder="描述你的研究主题、方法、任务和关键词。"
                    />
                  </label>
                  <label>
                    个人简介
                    <textarea
                      rows={5}
                      value={profileForm.bio}
                      onChange={(event) =>
                        setProfileForm((current) => ({ ...current, bio: event.target.value }))
                      }
                      placeholder="介绍你的背景、当前项目和想找的相关工作。"
                    />
                  </label>
                  <button type="submit">保存资料</button>
                </form>
              </article>

              <div className="side-stack">
                <article className="surface panel-compact">
                  <SectionTitle title="账户概览" />
                  <dl className="meta-list">
                    <div>
                      <dt>账号</dt>
                      <dd>{session.user?.email}</dd>
                    </div>
                    <div>
                      <dt>角色</dt>
                      <dd>{session.user?.role === 'owner' ? 'Owner' : 'Member'}</dd>
                    </div>
                    <div>
                      <dt>加入时间</dt>
                      <dd>{formatDate(session.user?.createdAt)}</dd>
                    </div>
                  </dl>
                </article>

                <article className="surface panel-compact">
                  <SectionTitle title="使用提示" />
                  <ul className="compact-list">
                    <li>研究方向里多写任务、数据和方法关键词。</li>
                    <li>论文条目优先保证 BibTeX 与摘要完整。</li>
                    <li>你生成的邀请码只在你的成员网络内流转。</li>
                  </ul>
                </article>
              </div>
            </div>
          ) : null}

          {currentPage === 'papers' ? (
            <div className="content-grid editor-grid">
              <article className="surface panel-form">
                <SectionTitle
                  title={editingPaperId ? '编辑论文' : '添加论文'}
                  note="作者、年份、venue 与链接会从 BibTeX 自动解析。"
                />
                <form className="form-grid" onSubmit={submitPaper}>
                  <label>
                    Title
                    <input
                      value={paperForm.title}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, title: event.target.value }))
                      }
                      placeholder="可选；若留空则从 BibTeX 提取"
                    />
                  </label>
                  <label>
                    BibTeX
                    <textarea
                      rows={11}
                      value={paperForm.bibtex}
                      onChange={(event) =>
                        setPaperForm((current) => ({ ...current, bibtex: event.target.value }))
                      }
                      placeholder="@article{...}"
                    />
                  </label>
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

              <article className="surface panel-list">
                <SectionTitle title="我的论文" note={papers.length ? `${papers.length} 篇条目` : undefined} />
                {papers.length ? (
                  <div className="list-stack">
                    {papers.map((paper) => (
                      <article className="entry-card" key={paper.id}>
                        <div className="entry-head">
                          <div>
                            <strong>{paper.title}</strong>
                            <p className="muted compact-line">
                              {paper.authors.join(', ') || '待从 BibTeX 提取作者'}
                              {paper.year ? ` · ${paper.year}` : ''}
                              {paper.venue ? ` · ${paper.venue}` : ''}
                            </p>
                          </div>
                        </div>
                        {paper.tldr ? <p className="entry-text">{paper.tldr}</p> : null}
                        <div className="button-row">
                          <button type="button" className="secondary" onClick={() => editPaper(paper)}>
                            编辑
                          </button>
                          <button type="button" className="secondary" onClick={() => void copyText(paper.bibtex)}>
                            复制 BibTeX
                          </button>
                          {paper.externalUrl ? (
                            <a className="link-button" href={paper.externalUrl} target="_blank" rel="noreferrer">
                              外部链接
                            </a>
                          ) : null}
                          <button type="button" className="danger" onClick={() => void removePaper(paper.id)}>
                            删除
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="还没有论文条目"
                    description="先贴一条 BibTeX 和摘要，站内推荐才有可用候选。"
                  />
                )}
              </article>
            </div>
          ) : null}

          {currentPage === 'invites' ? (
            <div className="content-grid editor-grid">
              <article className="surface panel-form">
                <SectionTitle title="生成邀请码" note="可以限制邮箱、使用次数和有效期。" />
                <form className="form-grid" onSubmit={createInvite}>
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
                  <div className="inline-fields">
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
                  </div>
                  <button type="submit">生成邀请码</button>
                </form>
              </article>

              <article className="surface panel-list">
                <SectionTitle title="已生成的邀请码" note={invites.length ? `${invites.length} 个邀请码` : undefined} />
                {invites.length ? (
                  <div className="list-stack">
                    {invites.map((invite) => (
                      <article className="entry-card" key={invite.id}>
                        <div className="entry-head">
                          <div>
                            <strong>{invite.code}</strong>
                            <p className="muted compact-line">
                              已用 {invite.usedCount}/{invite.maxUses}
                              {invite.targetEmail ? ` · ${invite.targetEmail}` : ''}
                            </p>
                          </div>
                          <button type="button" className="secondary" onClick={() => void copyText(invite.code)}>
                            复制
                          </button>
                        </div>
                        {invite.note ? <p className="entry-text muted">{invite.note}</p> : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="还没有邀请码" description="创建一个邀请码后，就可以邀请下一位成员加入。" />
                )}
              </article>
            </div>
          ) : null}

          {currentPage === 'recommendations' ? (
            <div className="content-stack">
              <article className="surface panel-form panel-form-compact">
                <SectionTitle title="生成候选引用" note="输入当前想补充的方向，系统会从站内论文库里筛选候选。" />
                <form className="form-grid" onSubmit={generateRecommendations}>
                  <label>
                    补充说明（可选）
                    <textarea
                      rows={4}
                      value={recommendationExtra}
                      onChange={(event) => setRecommendationExtra(event.target.value)}
                      placeholder="例如当前在补 related work，优先看任务相近、方法相邻的工作。"
                    />
                  </label>
                  <button type="submit">生成候选引用</button>
                </form>
              </article>

              {recommendations ? (
                <>
                  <div className="chip-row">
                    {recommendations.aspects.map((aspect) => (
                      <div className="chip-card" key={aspect.label}>
                        <strong>{aspect.label}</strong>
                        <span>{aspect.keywords.join(', ')}</span>
                      </div>
                    ))}
                  </div>

                  <div className="list-stack">
                    {recommendations.recommendations.map((item) => (
                      <article className="surface recommendation-card" key={item.paper.id}>
                        <div className="entry-head">
                          <div>
                            <strong>{item.paper.title}</strong>
                            <p className="muted compact-line">
                              {item.paper.ownerName ? `来自 ${item.paper.ownerName} · ` : ''}
                              {item.paper.authors.join(', ') || 'Unknown authors'}
                              {item.paper.year ? ` · ${item.paper.year}` : ''}
                              {item.paper.venue ? ` · ${item.paper.venue}` : ''}
                            </p>
                          </div>
                          <button type="button" className="secondary" onClick={() => void copyText(item.paper.bibtex)}>
                            复制 BibTeX
                          </button>
                        </div>
                        <div className="tag-row">
                          {item.matchedAspects.map((aspect) => (
                            <span className="tag" key={aspect}>
                              {aspect}
                            </span>
                          ))}
                        </div>
                        {item.paper.tldr ? <p className="entry-text">{item.paper.tldr}</p> : null}
                        <p className="muted compact-line">{item.reason}</p>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState title="还没有候选结果" description="先完善研究资料，再生成站内候选引用。" />
              )}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  ) : (
    <div className="public-shell">
      <section className="public-brand surface">
        <div className="brand-mark large">WC</div>
        <div className="public-copy-block">
          <p className="eyebrow">We Cites</p>
          <h1 className="public-title">邀请制研究者网络</h1>
          <p className="public-copy">用更安静、更紧凑的方式维护研究资料、论文条目和站内候选引用。</p>
        </div>
        <div className="public-features">
          <div className="chip-card compact">
            <strong>BibTeX 录入</strong>
            <span>自动提取作者、年份、venue 与链接</span>
          </div>
          <div className="chip-card compact">
            <strong>邀请制加入</strong>
            <span>成员通过邀请码扩展自己的研究者网络</span>
          </div>
          <div className="chip-card compact">
            <strong>站内候选引用</strong>
            <span>从成员上传的论文条目里筛候选文献</span>
          </div>
        </div>
      </section>

      <section className="public-panel">
        {notice ? <Banner tone="info" text={notice} /> : null}
        {loadingLabel ? <Banner tone="loading" text={loadingLabel} /> : null}

        <article className="surface auth-panel">
          <SectionTitle title="邮箱登录" />
          <form className="form-grid" onSubmit={loginWithEmail}>
            <label>
              邮箱
              <input
                type="email"
                autoComplete="email"
                value={loginForm.email}
                onChange={(event) => setLoginForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="you@example.com"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete="current-password"
                value={loginForm.password}
                onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="至少 8 位"
              />
            </label>
            <button type="submit">登录</button>
          </form>
        </article>

        <article className="surface auth-panel">
          <SectionTitle title="创建账号" note="初始管理员白名单邮箱可直接注册，其他新用户需要邀请码。" />
          <form className="form-grid" onSubmit={registerWithEmail}>
            <label>
              显示名称
              <input
                autoComplete="name"
                value={registerForm.name}
                onChange={(event) => setRegisterForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="例如 Ming Wang"
              />
            </label>
            <label>
              邮箱
              <input
                type="email"
                autoComplete="email"
                value={registerForm.email}
                onChange={(event) => setRegisterForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="you@example.com"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete="new-password"
                value={registerForm.password}
                onChange={(event) => setRegisterForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="至少 8 位"
              />
            </label>
            <label>
              邀请码
              <input
                value={registerForm.inviteCode}
                onChange={(event) => setRegisterForm((current) => ({ ...current, inviteCode: event.target.value }))}
                placeholder="普通成员注册需要填写"
              />
            </label>
            <button type="submit">创建账号</button>
          </form>
        </article>
      </section>
    </div>
  )
}

function Banner(props: { tone: 'info' | 'loading'; text: string }) {
  return <div className={`banner ${props.tone}`}>{props.text}</div>
}

function MetricCard(props: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

function SectionTitle(props: { title: string; note?: string }) {
  return (
    <div className="section-title">
      <h2>{props.title}</h2>
      {props.note ? <p className="muted compact-line">{props.note}</p> : null}
    </div>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="empty-state surface-muted">
      <strong>{props.title}</strong>
      <p className="muted compact-line">{props.description}</p>
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

function formatDate(value: string | undefined) {
  if (!value) {
    return 'Unknown'
  }
  return new Date(value).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function initialsOf(name: string | undefined) {
  const source = (name ?? '').trim()
  if (!source) {
    return 'WC'
  }
  const pieces = source.split(/\s+/).filter(Boolean)
  return pieces
    .slice(0, 2)
    .map((piece) => piece[0]?.toUpperCase() ?? '')
    .join('')
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

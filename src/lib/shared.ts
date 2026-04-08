export type AuthProvider = 'github' | 'google'
export type PaperSource = 'manual' | 'dblp' | 'semantic-scholar'

export interface AppFeatures {
  githubAuth: boolean
  googleAuth: boolean
  aiAnalysis: boolean
  vectorSearch: boolean
  semanticScholarImport: boolean
}

export interface UserSummary {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: 'owner' | 'member'
  researchSummary: string
  bio: string
  createdAt: string
}

export interface SessionPayload {
  user: UserSummary | null
  features: AppFeatures
  stats: {
    ownPaperCount: number
    networkPaperCount: number
  }
}

export interface InviteRecord {
  id: string
  code: string
  targetEmail: string | null
  note: string
  maxUses: number
  usedCount: number
  expiresAt: string | null
  createdAt: string
}

export interface PaperRecord {
  id: string
  ownerUserId: string
  ownerName: string | null
  title: string
  bibtex: string
  abstract: string
  introduction: string
  tldr: string
  authors: string[]
  year: number | null
  venue: string
  source: PaperSource
  sourceId: string | null
  externalUrl: string | null
  createdAt: string
  updatedAt: string
}

export interface ResearchAspect {
  label: string
  keywords: string[]
}

export interface RecommendationItem {
  paper: PaperRecord
  score: number
  matchedAspects: string[]
  matchedKeywords: string[]
  reason: string
}

export interface RecommendationPayload {
  aspects: ResearchAspect[]
  recommendations: RecommendationItem[]
  queryText: string
  usedAi: boolean
}

export interface ImportResult {
  source: Exclude<PaperSource, 'manual'>
  sourceId: string | null
  title: string
  authors: string[]
  abstract: string
  introduction: string
  tldr: string
  venue: string
  year: number | null
  externalUrl: string | null
  bibtex: string
}

export interface ApiError {
  error: string
}

export const emptyFeatures: AppFeatures = {
  githubAuth: false,
  googleAuth: false,
  aiAnalysis: false,
  vectorSearch: false,
  semanticScholarImport: true,
}

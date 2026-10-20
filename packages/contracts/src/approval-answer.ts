import { z } from 'zod'

// each word alone can only mean assent; no bare 'y': a false accept runs an unread plan
export enum ApprovalAnswer {
  approve = 'approve',
  approved = 'approved',
  agree = 'agree',
  agreed = 'agreed',
  yes = 'yes',
  ok = 'ok',
  okay = 'okay',
  lgtm = 'lgtm',
  go = 'go',
  proceed = 'proceed',
}

// the word the one-click approve button sends and docs tell a human to type
export const APPROVAL_ANSWER = ApprovalAnswer.approve

// whole-string match after trim and case-fold: 'do not approve' must not match
export const isApprovalAnswer = (text: string): boolean =>
  z.enum(ApprovalAnswer).safeParse(text.trim().toLowerCase()).success

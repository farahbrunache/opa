export const GOALS = {
  reach: {
    label: 'Reaching past the average',
  },
  smallest: {
    label: 'The smallest number',
  },
};

export function isGoal(value) {
  return Object.prototype.hasOwnProperty.call(GOALS, value);
}

export const ACTIVITY_STATES = ['todo', 'drafted', 'done', 'dropped'];

export const ACTIVITY_LABELS = { todo: 'To do', drafted: 'Drafted', done: 'Done', dropped: 'Dropped' };

export function isActivityState(value) {
  return ACTIVITY_STATES.includes(value);
}

export const ACTIVITY_SOURCES = ['you', 'redraw', 'steps'];

export const DROP_REASONS = {
  'not-the-right-time': 'Not the right time',
  'tried-it': "Tried it, didn't work",
  'changed-direction': 'They changed direction',
  'someone-else': 'Someone else did it',
  'not-needed': 'Not needed anymore',
  other: 'Other',
  'before-reasons': 'Before reasons were asked',
};

export const DROP_REASONS_OFFERED = [
  'not-the-right-time', 'tried-it', 'changed-direction', 'someone-else', 'not-needed', 'other',
];

export function isDropReason(value) {
  return DROP_REASONS_OFFERED.includes(value);
}

export const SKIP_REASONS = {
  'too-early': 'Too early',
  'not-their-goal': 'Not their goal',
  'already-doing': 'Already doing it',
  other: 'Other',
};

export function isSkipReason(value) {
  return Object.prototype.hasOwnProperty.call(SKIP_REASONS, value);
}

export const PASS_REASONS = {
  'already-know': 'Already know this',
  'not-their-goal': 'Not their goal',
  'too-early': 'Too early',
};

export function isPassReason(value) {
  return Object.prototype.hasOwnProperty.call(PASS_REASONS, value);
}

export const CADENCES = {
  none: { label: 'No reminder', days: null },
  daily: { label: 'Every day', days: 1 },
  'three-days': { label: 'Every 3 days', days: 3 },
  weekly: { label: 'Every week', days: 7 },
  fortnightly: { label: 'Every two weeks', days: 14 },
  monthly: { label: 'Every month', days: 30 },
};

export const CADENCES_OFFERED = ['none', 'daily', 'three-days', 'weekly'];

export function isCadence(value) {
  return Object.prototype.hasOwnProperty.call(CADENCES, value);
}

export const CONTACT_STATUSES = [
  'to approach',
  'reached out',
  'talking',
  'said no',
  'paying customer',
];

export function isContactStatus(value) {
  return CONTACT_STATUSES.includes(value);
}

export const CONTACT_PAID = 'paying customer';

export const WORK_STATES_OFFERED = ['to do', 'doing', 'done'];

export function isWorkState(value) {
  return WORK_STATES_OFFERED.includes(value);
}

export const WORK_DONE = 'done';

export function nextDueAt(cadence, from = new Date()) {
  const days = CADENCES[cadence]?.days ?? null;
  if (days === null) return null;
  return new Date(from.getTime() + days * 24 * 3_600_000).toISOString();
}

export const DECISIONS = ['go', 'no-go'];

export function isDecision(value) {
  return DECISIONS.includes(value);
}

export const EVENT_KINDS = {
  decided: 'Decided',
  pivot: 'New chapter',
  'chapter.edited': 'Chapter edited',
  'direction.notnow': 'Not now to a new direction',
  'brought-by.changed': 'Brought by changed',
  flagged: 'Flagged',
  unflagged: 'Flag removed',
  assessed: 'Decided',
  recommended: 'Recommendations written',
  'plan.set': 'Plan set',
  'activity.added': 'Activity added',
  'activity.drafted': 'Activity moved to Drafted',
  'activity.outcome': 'Outcome recorded',
  'activity.done': 'Activity done',
  'activity.reopened': 'Activity back to To do',
  'activity.dropped': 'Activity dropped',
  'activity.moved': 'Activity moved to To do',
  'activity.asked': 'Asked, still going',
  'activity.cadence': 'Reminder changed',
  'activity.migrated': 'Activity carried over',
  'roadmap.drafted': 'Roadmap drafted',
  'roadmap.accepted': 'Roadmap change accepted',
  'roadmap.skipped': 'Roadmap change skipped',
  'quote.due': 'Quote dated',
  'quote.paid': 'Quote paid',
  'session.bought': 'Session bought',
  'session.used': 'Session opened',
  'session.closed': 'Session closed',
  'access.requested': 'Access-rate session requested',
  'access.given': 'Access-rate session given',
  'access.listed': "On next month's list",
  'contact.added': 'Someone to approach',
  'contact.moved': 'Contact updated',
  'contact.reached': 'Reached out',
  'work.taken': 'Work taken on',
  'work.moved': 'Work updated',
  'quote.written': 'Quote written',
  'quote.moved': 'Quote updated',
  'introduction.made': 'Introduced',
  'introduction.recorded': 'Introduction outcome',
  'first-customer': 'First paying customer',
  'recommendation-done': 'Completed a recommendation',
  'conversation.opened': 'Conversation opened',
  'call-fields': 'Call notes saved',
  'own-profile': 'Directory profile linked',
  trade: 'Job title set',
  skills: 'Skills set',
  'quote.answered': 'Quote answered',
  'message.auto': 'Auto update sent',
  'message.template': 'Message sent from a template',
  'steps.posted': 'Next steps sent to the conversation',
  'step.done': 'Step marked done',
  'step.undone': 'Step unmarked',
  'questions.asked': 'Questions asked',
  'question.passed': 'Question set aside',
  'questions.suggested': 'AI suggested questions',
  'call.gaps': 'Gaps found',
  'pair.skipped': 'Suggestion skipped',
  'pair.unskipped': 'Skip undone',
  mine: 'Marked as yours',
  note: 'Note',
};

export const EVENT_GROUPS = {
  decided: ['edit', 'you'],
  pivot: ['edit', 'you'],
  'chapter.edited': ['edit', 'you'],
  'direction.notnow': ['msg', 'client'],
  'brought-by.changed': ['edit', 'you'],
  flagged: ['edit', 'you'],
  unflagged: ['edit', 'you'],
  assessed: ['edit', 'you'],
  recommended: ['edit', 'you'],
  'plan.set': ['edit', 'you'],
  'activity.added': ['edit', 'you'],
  'activity.drafted': ['edit', 'you'],
  'activity.outcome': ['edit', 'you'],
  'activity.done': ['edit', 'you'],
  'activity.reopened': ['edit', 'you'],
  'activity.dropped': ['edit', 'you'],
  'activity.moved': ['edit', 'you'],
  'activity.asked': ['edit', 'you'],
  'activity.cadence': ['edit', 'you'],
  'activity.migrated': ['edit', 'auto'],
  'roadmap.drafted': ['edit', 'you'],
  'roadmap.accepted': ['edit', 'you'],
  'roadmap.skipped': ['edit', 'you'],
  'quote.due': ['money', 'you'],
  'quote.paid': ['money', 'you'],
  'session.bought': ['money', 'you'],
  'session.used': ['money', 'you'],
  'session.closed': ['money', 'you'],
  'access.requested': ['money', 'client'],
  'access.given': ['money', 'auto'],
  'access.listed': ['money', 'auto'],
  'contact.added': ['edit', 'you'],
  'contact.moved': ['edit', 'you'],
  'contact.reached': ['edit', 'you'],
  'work.taken': ['edit', 'you'],
  'work.moved': ['edit', 'you'],
  'quote.written': ['money', 'you'],
  'quote.moved': ['money', 'you'],
  'introduction.made': ['edit', 'you'],
  'introduction.recorded': ['edit', 'you'],
  'first-customer': ['edit', 'you'],
  'recommendation-done': ['edit', 'you'],
  'conversation.opened': ['msg', 'auto'],
  'call-fields': ['edit', 'you'],
  'own-profile': ['edit', 'you'],
  trade: ['edit', 'you'],
  skills: ['edit', 'you'],
  'quote.answered': ['money', 'client'],
  'message.auto': ['msg', 'you'],
  'message.template': ['msg', 'you'],
  'steps.posted': ['msg', 'auto'],
  'step.done': ['edit', 'client'],
  'step.undone': ['edit', 'client'],
  'questions.asked': ['msg', 'you'],
  'question.passed': ['edit', 'you'],
  'questions.suggested': ['edit', 'you'],
  'call.gaps': ['edit', 'you'],
  'pair.skipped': ['edit', 'you'],
  'pair.unskipped': ['edit', 'you'],
  mine: ['edit', 'you'],
  note: ['note', 'you'],
};

export const EVENT_BY = {
  you: 'By you', auto: 'Automatic', client: 'From client', voice: 'Voice service', payment: 'Payment',
};

export function isEventKind(value) {
  return Object.prototype.hasOwnProperty.call(EVENT_KINDS, value);
}

export const RATES = ['access', 'standard'];

export const RATE_LABELS = { access: 'Access rate', standard: 'Standard rate' };

export function isRate(value) {
  return RATES.includes(value);
}

export const INTRODUCTION_OUTCOMES = ['waiting', 'worked', 'went nowhere'];

export function isIntroductionOutcome(value) {
  return INTRODUCTION_OUTCOMES.includes(value);
}

export const CALL_KINDS = ['intake', 'follow-up'];

export function isCallKind(value) {
  return CALL_KINDS.includes(value);
}

export const MESSAGE_AUTHORS = ['operator', 'client'];

export function isMessageAuthor(value) {
  return MESSAGE_AUTHORS.includes(value);
}

export const POOL_SETTING = 'funnel.pool';

export const FUNNEL_STAGES = [
  { key: 'pool', label: 'Approached', entered: true },
  { key: 'paid', label: 'Paid' },
  { key: 'called', label: 'Had the call' },
  { key: 'go', label: 'Got a go' },
  { key: 'done', label: 'Done' },
];

export const QUEUE_STATES = ['waiting', 'replies', 'active', 'closed'];

export function isQueueState(value) {
  return QUEUE_STATES.includes(value);
}

export const MESSAGES_PER_PAGE = 20;

export const AUTO_UPDATE_MAX = 300;

export function pageOf(asked, total, perPage = MESSAGES_PER_PAGE) {
  const last = Math.max(1, Math.ceil(total / perPage));
  const wanted = Number.parseInt(asked, 10);
  if (!Number.isFinite(wanted)) return { page: last, last, perPage };
  return { page: Math.min(Math.max(wanted, 1), last), last, perPage };
}

export const BLOCKER_RETURNS_AFTER_DAYS = 7;

export const REVIEW_TARGET_HOURS = 24;
export const REVIEW_PROMISE_HOURS = 48;

export function conversationIsOpen({ approvedAt }) {
  return Boolean(approvedAt);
}

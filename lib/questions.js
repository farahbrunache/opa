export const STAGES = {
  any: {
    label: 'Any stage',
  },
  start: {
    label: 'Working out the offer',
  },
  first: {
    label: 'Toward a first customer',
  },
  steady: {
    label: 'Keeping it steady',
  },
  further: {
    label: 'Going further',
  },
};

export const STAGE_ORDER = ['any', 'start', 'first', 'steady', 'further'];


export function isStage(value) {
  return Object.prototype.hasOwnProperty.call(STAGES, value);
}

export function stageFor({ decision, firstCustomerAt = null, goal = null }) {
  if (decision && decision !== 'go') return null;
  if (firstCustomerAt) return goal === 'reach' ? 'further' : 'steady';
  if (decision === 'go') return 'first';
  return 'start';
}

export function fits(question, stage) {
  return question.stage === 'any' || question.stage === stage;
}

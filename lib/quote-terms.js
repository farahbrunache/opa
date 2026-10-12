export const QUOTE_TERMS = "Agreeing means you'll pay this amount for this work. The work starts "
  + "as soon as the payment arrives, and once it's paid there are no refunds.";

export const QUOTE_ACCEPT = "I want the work to start as soon as it's paid, and I understand "
  + "there's no refund after that.";

export function agreedWording() {
  return `${QUOTE_TERMS} ${QUOTE_ACCEPT}`;
}

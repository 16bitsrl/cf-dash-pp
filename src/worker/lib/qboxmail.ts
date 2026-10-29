// Qboxmail also answers on three white-label domains, each with its own MX and SPF include.
// Apart from mail.ts and senders.ts, which import each other.

export const QBOX_WHITE_LABEL = /(cbsolt\.net|cloudisp\.net|emailpnl\.com)$/;
export const QBOX_MX = /(^|\.)(qboxmail\.(com|it)|cbsolt\.net|cloudisp\.net|emailpnl\.com)$/;
export const QBOX_SPF = /^spf(-c)?\.(qboxmail\.com|cbsolt\.net|cloudisp\.net|emailpnl\.com)$/;

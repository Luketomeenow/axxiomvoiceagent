/**
 * Machine-reach classification from the transcript. With Twilio AMD off
 * (ENABLE_VOICEMAIL_DETECTION=false, the default — it misclassifies live
 * humans), a call that hits an answering machine or a phone tree ends as a
 * normal "customer-ended-call" and the agent rarely gets a recordDisposition
 * in before the hangup — so voicemail/IVR were all falling into the generic
 * needs_followup fallback and "Who we reached" showed voicemail = 0.
 *
 * This classifies from what the "customer" actually said: voicemail greetings
 * and IVR menus use highly stereotyped language. Used by the end-of-call
 * fallback in handlers.ts (only when no tool set a disposition) and by the
 * analytics backfill. Twilio AMD (answered_by) remains the authoritative
 * source when it's enabled.
 */

// Unambiguous machine phrases — a live person never says these.
const VOICEMAIL_STRONG: RegExp[] = [
  /after the (tone|beep)/,
  /at the tone/,
  /voice ?mail/,
  /mailbox/,
  /record your message/,
  /has been forwarded to/,
  /automated voice messaging/,
  /google voice/,
  /when you('re| are) finished,? (you may )?hang up/,
  /the person you('re| are) trying to reach/,
];
// Phrases a live receptionist can also say ("would you like to leave a
// message?", "he's not available") — require TWO distinct ones to classify.
const VOICEMAIL_WEAK: RegExp[] = [
  /leave (a |your |me a )?(message|name|voicemail)/,
  /is not available/,
  /not available (to take|right now)/,
  /unable to (take|answer) your call/,
  /cannot take your call/,
  /please leave/,
];

const IVR_PATTERNS: RegExp[] = [
  /press (one|two|three|four|five|six|seven|eight|nine|zero|\d|star|pound)/,
  /para español/,
  /if you know your party'?s extension/,
  /listen carefully,? as our menu/,
  /menu options (has|have) changed/,
  /(choose|select) from the following/,
  /following (options|menu)/,
  /to speak (with|to) (a|an) (representative|operator|member)/,
  /this is an automated (attendant|system|line)/,
  /automated (attendant|answering) (system|service)/,
  /main menu/,
  /dial (the extension|by name)/,
];

/**
 * Classify a finished call's transcript as reaching a voicemail box or an IVR
 * menu, from the CUSTOMER side's stereotyped machine language. Returns null
 * when the transcript looks like a live conversation (or is empty).
 * Voicemail wins over IVR (VM greetings often also say "press ..."-style
 * options; a menu never asks you to leave a message after the tone).
 */
export function classifyMachineReach(transcript: string | null | undefined): "voicemail" | "ivr" | null {
  if (!transcript?.trim()) return null;
  const lines = transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // Vapi transcripts prefix each line with a role ("AI:", "User:"). Match only
  // the customer's lines so the agent's own words can't trigger a match; fall
  // back to the whole text only when there are no role prefixes at all.
  const hasRoles = lines.some((l) => /^[a-z]+\s*:/i.test(l));
  const hay = (
    hasRoles ? lines.filter((l) => /^(user|customer|caller|human|prospect)\s*:/i.test(l)).join("\n") : transcript
  ).toLowerCase();
  if (!hay.trim()) return null;
  const weakHits = VOICEMAIL_WEAK.filter((re) => re.test(hay)).length;
  if (VOICEMAIL_STRONG.some((re) => re.test(hay)) || weakHits >= 2) return "voicemail";
  if (IVR_PATTERNS.some((re) => re.test(hay))) return "ivr";
  return null;
}

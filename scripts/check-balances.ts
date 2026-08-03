/**
 * Diagnostic: verify the provider balance lookups (Twilio + Vapi) work with the
 * configured credentials — same pattern as check-outbound-db. Run with:
 *   bun run check-balances
 */

import { getProviderBalances } from "../src/outbound/balances.ts";

const { twilio, vapi, fetchedAt } = await getProviderBalances();

console.log(`Provider balances @ ${fetchedAt}\n`);
for (const [name, b] of Object.entries({ Twilio: twilio, Vapi: vapi })) {
  if (b.ok) {
    console.log(`  ${name}: $${b.balance?.toFixed(2)} ${b.currency}${b.detail ? ` (${b.detail})` : ""}`);
  } else {
    console.log(`  ${name}: unavailable — ${b.error}`);
  }
}

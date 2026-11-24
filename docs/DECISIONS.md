# Decisions

## Made (do not revisit without the owner)

| # | Decision | Reason |
|---|---|---|
| 1 | Sign-in is company single sign-on only; the CRM stores no passwords | Inherits the company's two-factor rules; one consent also grants mail and calendar |
| 2 | Email goes out from each rep's own mailbox, one message per click | Best deliverability, natural replies, no bulk-mail risk |
| 3 | No automated sequences and no open-tracking pixels in version 1 | Keeps a person on every send; open tracking is unreliable and raises privacy questions |
| 4 | Visibility is enforced in the repo layer with a mandatory route test | Simple to reason about at this size; database row-level security can be added later |
| 5 | Jobs run on pg-boss inside Postgres | One less system to run for 5 users |
| 6 | Compliance checks are code; AI only adds advisory flags | Rules that must hold can't depend on a model's judgment |
| 7 | Fit score and next best actions are rules, not AI | Predictable, explainable, testable |
| 8 | The CRM is separate from operations data; proof points come from a hand-maintained `client_references` table | Sales staff must not see guard locations or incidents; an operations feed can replace manual entry later |
| 10 | Company email and calendar are Microsoft 365: sign-in through Microsoft Entra ID, mail and calendar through Microsoft Graph (`IDP=microsoft`) | Confirmed by the owner |
| 9 | Prospect discovery is CSV import + manual add + website research | Prospect data must come from a licensed source; a provider adapter can be added behind `account_source = 'provider'` |

## Open (the owner must answer before the milestone shown)

| # | Question | Needed by | Default if unanswered |
|---|---|---|---|
| B | Which AWS account and region, and which Claude models are enabled in Bedrock there? | Milestone 3 | `us-east-1`; a Sonnet-class model for writing and a Haiku-class model for fast tasks. Confirm exact model ids in the Bedrock console |
| C | E-signature vendor (for example Dropbox Sign or DocuSign) and the service agreement template | Milestone 6 | Dropbox Sign adapter; a placeholder agreement marked DRAFT |
| D | Maps vendor for geocoding and drive time | Milestone 5 | Google Maps Platform |
| E | Real pricing: hourly rates, add-on prices, term discounts, discount limit | Milestone 6 | The demo's numbers in `ARCHITECTURE.md` §6, marked "unconfirmed" in Admin |
| F | Company postal address, sales phone numbers, counter-signer for contracts | Milestone 4 | Startup refuses to send email until the address is set |
| G | Office and VPN IP ranges allowed to reach the app | Milestone 8 | Staging open to signed-in users only; production blocked until set |
| H | Which client references may be named, and their real statistics | Milestone 3 | All references anonymized |
| I | Daily email cap per rep | Milestone 4 | 50 |
| J | Property types list and default package per type | Milestone 2 | Industrial, Cold chain warehouse, Medical office, Construction site, Class A office, Data center, Multifamily, Hospitality, Retail, Self storage |
| K | Lost reasons list | Milestone 2 | Price, Stayed with incumbent, No budget, No response, Timing, Not a fit, Other |
| L | Has counsel reviewed cold email, calling and prospect-data rules for the states you sell in? | Before production | Production launch is blocked |

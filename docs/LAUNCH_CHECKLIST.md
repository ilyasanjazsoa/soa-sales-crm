# Launch checklist

Claude Code builds the software. These are the things only the company can do. Nothing here is optional for a production launch.

## Before milestone 1
- [ ] Private GitHub repository created; Claude Code and `gh` installed
- [ ] IT admin registers the CRM as an internal app for sign-in, mail and calendar, with admin consent for the scopes in ARCHITECTURE.md §15, and provides the client id and secret

## Before milestone 3
- [ ] AWS account chosen; Claude models enabled in Amazon Bedrock in the chosen region; exact model ids noted (item B)
- [ ] Client references entered by the sales manager, with written permission recorded for any that may be named (item H)

## Before milestone 5 and 6
- [ ] Maps API key (item D)
- [ ] E-signature account, API key and the service agreement template approved by counsel (item C)
- [ ] Real pricing confirmed by leadership (item E)
- [ ] Company postal address and counter-signer set (item F)

## Before production
- [ ] Counsel has reviewed: cold email rules (CAN-SPAM), calling and texting rules (TCPA and state rules), storage of prospect personal data (state privacy laws), and the licence terms of any prospect data you import (item L)
- [ ] Office and VPN IP ranges set (item G)
- [ ] Domain name and certificate for the app and for the public proposal links
- [ ] An independent security test of staging, with findings fixed
- [ ] Backup restore rehearsed
- [ ] Someone named as the on-call owner for alarms

## Pilot (2 weeks, 2 AEs)
- [ ] Import each pilot rep's real prospects by CSV
- [ ] Each rep connects their mailbox and calendar and sets their base address and hours
- [ ] Daily 10-minute check: anything wrong in a brief, a draft, a proposed time, a price?
- [ ] Track: emails sent, replies, meetings booked, proposals sent, time from first touch to meeting
- [ ] Fix list agreed, then onboard the remaining 3 AEs with a 45-minute walkthrough

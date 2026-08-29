# Stock Token eligibility

Stock Token eligibility belongs to the verified human/company owner, never to an AI agent, IP address, VPN, prompt, or agent runtime. Persistent states are `UNKNOWN`, `PENDING`, `ELIGIBLE`, `INELIGIBLE`, and `EXPIRED`. Only a current `ELIGIBLE` attestation may enable or execute trading.

`EligibilityProvider` is a replaceable compliance boundary. An assessment records provider, versioned rules, opaque attestation ID, verification/expiry timestamps and a non-sensitive reason code. Country lists are not hardcoded in application source because restrictions can change. The provider must bind the assessment to the Normic owner issuer/subject and company and must be reviewed by deployment counsel/compliance owners.

This repository deliberately ships `UnavailableEligibilityProvider`. It never asserts eligibility and makes live Stock Token trading **BLOCKED**. Read-only public market reference data can remain available under its own upstream terms. Deployments must implement and review a real provider before activation.

Normic does not make a legal eligibility decision with a language model and does not claim that technical availability means a user may trade. See Robinhood's current [Stock Token overview and disclosures](https://docs.robinhood.com/chain/stock-tokens/) before deployment.

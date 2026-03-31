# Production Partner Onboarding Pack

Use this pack when a Beam conversation moves from "interesting" to "we are seriously considering one production workflow."

This pack is buyer-facing first. It is the shared document both sides should be able to read before a call, before a pilot, and before a go-live discussion.

The public path still starts here:

- [Guided Evaluation](https://beam.directory/guided-evaluation.html)
- [Hosted Beta Intake](https://beam.directory/hosted-beta.html)

The canonical `1.0.0` production definition now lives here:

- [First Production Partner Workflow Contract](/guide/production-partner-workflow)
- [Production Go-Live Checklist](/guide/production-go-live-checklist)

## What This Pack Is For

Use it to keep the first production conversation narrow and honest:

1. one named workflow,
2. one sender and one recipient,
3. one buyer-side owner,
4. one operator owner,
5. one explicit success condition,
6. one next decision after the first proof.

Do not use the first production discussion as a broad "agent platform" tour. The first job is to decide whether the named workflow deserves a real go-live path.

## Canonical 1.0.0 Workflow

Beam `1.0.0` is anchored on one concrete production shape:

**Quote Approval Partner Handoff**

In plain language:

1. a buyer-side procurement agent asks a supplier or partner-side operations agent for stock, delivery timing, and a quote,
2. the partner-side agent responds on the same Beam thread,
3. the buyer-side operator and finance owner can inspect the trace, the proof, and the next action without losing the request history.

Read the full contract in [First Production Partner Workflow Contract](/guide/production-partner-workflow).

## Buyer Expectations Before The Evaluation

Before the call starts, the external team should already know:

- Beam is for one company handing work to another company with a visible paper trail.
- The first production path is scoped to one real workflow, not a broad rollout.
- The goal is to inspect the proof and decide whether one hosted pilot and go-live checklist make sense.
- The likely next step after a good call is a narrow workflow rollout, not an open-ended beta promise.

## What We Need Before Scheduling

Collect these six inputs before the first serious session:

1. The first workflow in one sentence.
2. The sender and receiver sides.
3. The buyer-side business owner.
4. The operator who will care when the handoff stalls.
5. The success condition for the first pilot.
6. The blocker or risk that makes visibility matter.

### Intake Checklist

- Company name
- Primary team email
- Workflow type
- One-paragraph workflow summary
- Estimated number of agents or systems involved
- Internal owner on the buyer side
- Clear reason this workflow matters now

## Production Readiness Prerequisites

These are the six prerequisites Beam operators track directly in the dashboard before go-live:

1. Workflow owner confirmed
2. Sender and receiver confirmed
3. Success metric confirmed
4. Security review confirmed
5. Go-live window confirmed
6. Proof recipients confirmed

If any of these are missing, the request should stay explicitly blocked. Do not hide go-live risk inside free-form notes.

## Expected Timeline

The first production motion should feel boring:

1. **Guided evaluation**
   - confirm the workflow and the operator proof path
   - stop if the workflow is still vague
2. **Scoped pilot**
   - agree on one owner, one success condition, and one proof package
   - record reminders, next meeting, and next action in the request record
3. **Go-live review**
   - walk the [Production Go-Live Checklist](/guide/production-go-live-checklist)
   - mark any blocked prerequisites in the dashboard
4. **First production window**
   - keep one operator owner on the thread
   - use the same trace, signal, and proof surfaces as the pilot
5. **Proof recap and decision**
   - send the proof pack
   - decide whether to expand, narrow, or stop

## What The Guided Evaluation Should Cover

The canonical sequence is:

1. Restate the buyer workflow in plain language.
2. Show the [First Production Partner Workflow Contract](/guide/production-partner-workflow).
3. Show the healthy Beam overview baseline.
4. Open one request trace and walk stage by stage.
5. Explain what happens when follow-up is async or delayed.
6. Confirm what a hosted pilot and go-live path would look like if the fit is real.

## Proof Checklist

The evaluation is only good if the proof is clear enough for a normal buyer to repeat back.

Show all of these:

- a healthy operator baseline,
- one request trace from arrival to reply,
- one explicit owner and next action,
- where go-live blockers would be tracked,
- what happens when the handoff needs follow-up later,
- where an operator would look if the flow stalled.

## What The Buyer Should Leave With

At the end of the evaluation, the buyer should have:

- a clear answer on whether Beam fits one workflow,
- a shared understanding of what the first pilot would cover,
- one named owner on both sides,
- one concrete next action,
- one clear picture of what has to be true before go-live,
- no confusion about whether self-hosting or repo setup is required first.

## Operator Preparation Checklist

Before the call:

- confirm the public guided evaluation page still reflects the current proof path,
- make sure the workflow contract still matches the production story,
- open the dashboard and confirm the system baseline is healthy,
- know which follow-up template matches the likely request stage,
- have the onboarding pack and the go-live checklist open in the same browser session.

After the call:

- update the request stage,
- assign or confirm owner,
- record the next action,
- record last contact time,
- record blocked go-live prerequisites if any are missing,
- send the correct follow-up template.

## Follow-Up Templates

These templates are intentionally short. The goal is clarity and next action, not marketing copy.

<a id="template-new"></a>
## Template: New Request Acknowledgement

```text
Subject: Beam production workflow review received

Hi {{name}},

We received your Beam request for {{company}}.

The next step on our side is a quick workflow review so we can confirm whether the first production-shaped handoff is narrow enough for a pilot. We will use the workflow summary you sent to assign an operator owner and send the right proof path before the call.

What we need from you:
- the first workflow in one sentence
- who sends the work
- who receives it
- what a good outcome looks like

Reference:
- Guided evaluation: https://beam.directory/guided-evaluation.html
- Workflow contract: https://docs.beam.directory/guide/production-partner-workflow
- Onboarding pack: https://docs.beam.directory/guide/design-partner-onboarding

Best,
{{operator}}
```

<a id="template-reviewing"></a>
## Template: Reviewing / Clarification Needed

```text
Subject: Beam workflow clarification

Hi {{name}},

We reviewed the request and want to keep the first production discussion narrow.

Before we schedule anything, please reply with:
- the first sender and receiver in the workflow
- the one handoff that matters most
- the person who owns the result if it stalls
- the success condition that would count as "ready to proceed"

Beam works best when the first production path stays focused on one real partner handoff instead of a broad platform rollout.

Reference pack:
- https://docs.beam.directory/guide/production-partner-workflow
- https://docs.beam.directory/guide/design-partner-onboarding

Best,
{{operator}}
```

<a id="template-contacted"></a>
## Template: Contacted / Next Action Sent

```text
Subject: Beam workflow next step

Hi {{name}},

Thanks for the context. The next step is {{next_action}}.

Before the session, please review:
- the guided evaluation path: https://beam.directory/guided-evaluation.html
- the workflow contract: https://docs.beam.directory/guide/production-partner-workflow
- the onboarding pack: https://docs.beam.directory/guide/design-partner-onboarding

The call will stay focused on one workflow, the proof Beam shows for it, and whether that workflow deserves a real pilot and go-live review.

Best,
{{operator}}
```

<a id="template-scheduled"></a>
## Template: Scheduled Evaluation

```text
Subject: Beam evaluation scheduled

Hi {{name}},

Your Beam evaluation is scheduled for {{date_time}}.

What we will cover:
- the workflow in plain language
- the Beam proof path for one request
- what a narrow hosted pilot and go-live checklist would include if the fit is real

Please bring:
- the business owner for the workflow
- the operator or technical owner who will care when it stalls
- the success condition for the first pilot

Reference pack:
- https://docs.beam.directory/guide/production-partner-workflow
- https://docs.beam.directory/guide/design-partner-onboarding

Best,
{{operator}}
```

<a id="template-active"></a>
## Template: Active Pilot Follow-Up

```text
Subject: Beam pilot is active

Hi {{name}},

Beam is now active for the scoped workflow we agreed on.

Current owner: {{owner}}
Current next action: {{next_action}}

If the workflow stalls, we will use the operator path to inspect the trace, confirm the current stage, and decide the next recovery step. We will also keep any go-live blockers attached to the same request instead of splitting them across separate notes.

Best,
{{operator}}
```

<a id="template-closed"></a>
## Template: Closed / Not The Right Fit Right Now

```text
Subject: Beam workflow follow-up

Hi {{name}},

Thanks again for the conversation.

We are closing the current Beam request for now because the first workflow is not narrow enough yet, the timing is not right for a hosted pilot, or the go-live prerequisites are not ready yet.

If that changes, the best restart is:
- one workflow
- one sender
- one recipient
- one success condition

When that exists, restart from:
- https://beam.directory/guided-evaluation.html
- https://beam.directory/hosted-beta.html

Best,
{{operator}}
```

## Pack Links

- [Guided Evaluation](https://beam.directory/guided-evaluation.html)
- [Hosted Beta Intake](https://beam.directory/hosted-beta.html)
- [First Production Partner Workflow Contract](/guide/production-partner-workflow)
- [Production Go-Live Checklist](/guide/production-go-live-checklist)
- [Operator Runbook](/guide/operator-runbook)
- [Hosted Quickstart](/guide/hosted-quickstart)

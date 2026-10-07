---
title: Review process
description: How pull requests are reviewed and merged, and how to give and answer review feedback.
---

# Review process

Every pull request to Lifer is reviewed before it's merged. This page covers what happens from the moment you're ready to open one until it's merged, for authors and reviewers alike. How AI may be used along the way is covered by the [AI usage policy](./ai-policy.md); both apply.

## Who reviews

- **Maintainer review is required.** The maintainer reviews every pull request and is the only one who merges. That review covers the code itself, and also how the change fits the rest of Lifer, what it commits the project to, and whether the care taken matches the risk.
- **Community review is welcome.** Anyone can review a pull request. It doesn't replace the maintainer's review, but it often catches things, and it's the best way to learn the codebase. Reviewing isn't reserved for experts: "I don't understand this part" is useful feedback, because code other contributors can't follow is a problem worth knowing about.
- Nobody approves their own pull request.

While the maintainer is the only reviewer, their own changes don't get a second person's review. They still go through a pull request when practical, and always through the same CI checks and the [self-review checklist](#before-you-ask-for-review) below.

## The principles

- **Review is about the code.** Comments describe what the code does and what should change. They never describe the author.
- **Approval means understanding.** Approving says you read the change, ran it, and understand what it does.
- **The author owns the change.** Review is a check, not a substitute for the author's own work. A reviewer catching a bug doesn't move the bug onto them.
- **Everyone's on the same side.** The goal is a correct change in Lifer. A problem found in review is the process working.

## Before you ask for review

This is the author's job, and review starts after it:

- **Run it.** Use Lifer with your change, as the [AI usage policy](./ai-policy.md#running-it-yourself) describes.
- **Read your whole diff.** Every file and line, including anything you didn't type yourself. If something surprises you, sort it out first.
- **Remove stray changes:** debug output, commented-out code, unrelated reformatting, files you didn't mean to touch.
- **Check the comments are accurate.**
- **Run the checks** (`npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`) and make sure tests cover the change and would fail if it broke.
- **Make sure you can explain it.** See the [explainability test](./ai-policy.md#the-explainability-test).

Then open the pull request, write the description yourself using the template, and mark it ready. If it isn't finished, open it as a draft. Keep one change per pull request: unrelated fixes go in their own.

## How a review is done

1. **Understand the goal first.** Read the linked issue and the description before the code.
2. **Read the diff, all of it.** Look for whether it solves the stated problem, logic errors and missed cases, errors that get swallowed, comments that don't match the code, references to things that don't exist, and departures from how the rest of Lifer does things. Chase down anything that looks odd rather than assuming it's fine.
3. **Check the tests.** Would they fail if the code broke?
4. **Pull it and run it.** A reviewer who hasn't run the change hasn't reviewed it. Check the change and the features around it.
5. **Leave feedback,** then approve or say clearly what's blocking.

Don't approve without reading and running it, approve because you trust the author, or rewrite the author's code yourself instead of raising the issue.

## Writing feedback

Start every comment with what kind it is, so the author knows whether it blocks:

| Prefix | Meaning |
|---|---|
| **Blocking:** | Must change before merge. |
| **Question:** | You need an answer to finish reviewing. |
| **Suggestion:** | Take it or leave it. Won't block. |
| **Nit:** | Style or preference. Never blocks. |

- Describe the code, not the person: "this returns before the transaction commits", not "you forgot to commit".
- Say what's wrong and why it matters, and point at the line.
- Ask when you can't tell whether something is intentional.
- Say when something is well done, so the author knows to keep doing it.
- Raise a real problem before style. A wall of nits hides the one comment that matters.

No sarcasm, no "obviously", "just" or "simply", and nothing about the author's skill or effort. The [Code of Conduct](https://github.com/Sparklysparkspark/lifer-app/blob/main/CODE_OF_CONDUCT.md) applies to every comment.

## Answering feedback

- **Reply to every comment,** even if only "done". Make the change or explain why not.
- **Answer questions directly.** If you can't explain why your code works a certain way, that's the explainability test catching something.
- **Push fixes as new commits** rather than force-pushing over reviewed work, so reviewers can see what changed. Pull requests are squashed when merged, so the history stays tidy anyway.
- **Resolve a thread only once it's actually addressed.**

Disagreeing is fine. Say what you'd do instead and why, once. If you still disagree after that, stop the back-and-forth and ask for a decision; for this project, the maintainer's decision is final for that pull request. A disagreement about the overall approach belongs in an issue or discussion before the code, which is why big changes start there.

## Merging

A pull request is merged when all of these are true:

- The maintainer has approved it.
- Every blocking comment is resolved, and every other comment has a reply.
- CI is green.
- The title follows [Conventional Commits](https://www.conventionalcommits.org/), since it becomes the commit message.

If substantial changes are pushed after an approval, the approval no longer counts, and the change gets looked at again.

## Timing

Lifer is maintained in spare time, so there's no guaranteed turnaround. The aim is a first response within a week. If a pull request has had no reply for a week, a polite ping is welcome. A pull request with no activity from its author for 30 days, after a reminder, may be closed; it can always be reopened.

## Conduct

Review puts people in the position of critiquing each other's work in public, permanently. Keep every comment about the code. If a review crosses the line, don't answer it in the thread: raise it as described in the [Code of Conduct](https://github.com/Sparklysparkspark/lifer-app/blob/main/CODE_OF_CONDUCT.md). Being kind never means approving work that isn't ready; being direct and specific is fine.

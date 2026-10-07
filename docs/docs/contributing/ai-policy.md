---
title: AI usage policy
description: How AI tools may be used when contributing to Lifer, and where a person has to be in the loop.
---

# AI usage policy

Lifer is built with the help of AI coding tools, and contributors are welcome to use them too. This page sets out how. It applies to everyone who contributes, the maintainer included, and to every kind of contribution: code, tests, docs, issues and reviews.

It isn't a statement about whether AI is good. Where it allows AI, you're free to use it or not. Where it limits AI, the limit holds however good the tool seems.

## The principles

### You are the author

Whatever you submit, you wrote, whoever or whatever typed it. A tool doesn't share the credit or the blame, and "the AI did that" is never an answer to a review question.

### The explainability test

You must be able to answer these about your change, without going back to the tool:

1. **What does it do?** In your own words, at the level of detail the change needs.
2. **Why this way?** What else you considered, and why this approach is the best one, not just one that works.
3. **How does it fail?** Error paths, edge cases, bad input.
4. **What does it touch?** Every part of Lifer it affects, and everyone downstream: desktop users, servers, the API, the data pipeline.

If you can't, the change isn't ready. This applies the same way to a first-time contributor and to the maintainer.

### Understanding sets the pace

AI makes it easy to produce more change than anyone can carefully review. A small, well-understood pull request will get merged; a huge one nobody can follow won't, however correct it might be.

## Stage by stage

### Issues and ideas

AI may help you write up a bug report or a feature idea. Before you post it, check that it's true: that the steps really reproduce the bug on your install, and that the logs are real and from your machine. An invented reproduction wastes everyone's time.

What Lifer works on next is the maintainer's decision, made with the community in [Discussions](https://github.com/Sparklysparkspark/lifer-app/discussions). It isn't delegated to an AI ranking of the backlog.

### Designing a change

For anything big enough to discuss first (see [CONTRIBUTING.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/CONTRIBUTING.md)), a person owns the plan. AI is a good sparring partner: use it to find options, gaps and prior art in the codebase. It can also write the proposal for you. But every decision in it is yours, so read every line before you post it, and watch for decisions the tool made that nobody asked for.

### Exploring the code

Use AI freely here. It's good at mapping which files a change touches, tracing data through the API, web app and pipeline, and explaining unfamiliar code. Treat what it tells you as leads to check: it will name files that don't exist and miss callers it never looked at. You're done exploring when you can explain the relevant code yourself, not when you can repeat the tool's summary.

### Writing code

Any line may be written by AI. There's no quota and nothing to prove by typing it by hand. What matters is that you steered it to the right solution and understand what came back:

- You know the full extent of the change, including anything the tool added that you didn't ask for.
- You can say why each piece lives where it does.
- Every comment in the diff is accurate and one you'd defend. A comment describing code that no longer exists is your bug.

The more a change could hurt users (storage moves, imports, migrations, anything that deletes or rewrites files, authentication), the more thoroughly you're expected to understand it, and the harder review will push. When unsure, assume the stricter reading.

### Tests

AI may write tests, and it's good at the repetitive parts. It's also good at writing tests that pass and catch nothing: tests that check a mock returns what it was told to, that only cover the happy path, or that freeze a bug in place as expected behavior.

So before a test counts, **break the code on purpose**: flip a condition, return the wrong value, delete a line, and confirm the test fails. If it still passes, fix the test or remove it. For every test you submit, you can say what behavior it protects.

### Running it yourself

Before you open a pull request, **run Lifer with your change and use it**, the way a person would. A green test suite or an agent saying "done" isn't the same thing. Check the change itself, the features next to it, and the obvious bad inputs and empty states. For UI, look at it in light and dark mode and at a narrow window width.

If you couldn't run it (say, a GPU path you don't have the hardware for), say so in the pull request.

### Commits

Agents may write commits and commit messages. Keep messages as long as the change needs and no longer.

### Pull requests and review comments

**People write these.** You write the pull request title and description yourself, using the template, including the section on how you used AI. If the description is hard to write, that's the signal you don't yet understand the change well enough to submit it.

Comments on pull requests, from authors and reviewers alike, are written by people too. Don't paste review feedback into a tool to draft your reply, and don't post AI-generated reviews of someone else's work. AI may help a reviewer get oriented in a large diff; the review itself is the reviewer's own (see the [review process](./review-process.md)).

### Merging and releasing

Only the maintainer merges, and only after the review and CI pass. Once that's done, an agent may run the mechanical steps (merging, tagging a release). Changes to CI, the release workflow or the Docker image are design changes and go through review like any other code. After a release, a person checks that it actually works: installs update and servers start.

## Data you must never give an AI tool

- **Secrets:** API keys, tokens, passwords, database connection strings, signing keys, `.env` files.
- **Other people's data from issues and logs:** names, email addresses, IP addresses, account details.
- **Photo locations you don't own,** and the exact locations of sensitive species. Lifer hides these on purpose (see `packages/core/src/species/sensitiveSpecies.ts`); a log or database dump can still contain them.
- **Anyone's private photos or library database.**

Use made-up data to reproduce a problem. A fake photo with fake EXIF data is as useful as a real one. If something leaks anyway, report it privately as described in [SECURITY.md](https://github.com/Sparklysparkspark/lifer-app/blob/main/SECURITY.md) so it can be dealt with quickly.

## Tools

Use whichever AI tools you like. You're responsible for their terms, including whether they claim rights over what they produce and what they do with what you paste in. Don't give any tool access to the repository's secrets, release signing keys or anyone's server.

## Enforcement

A pull request that doesn't meet this policy isn't merged. The first time, that's a conversation in review, not a punishment. Repeatedly submitting work you can't explain, or large unreviewed generated changes, gets pull requests closed without detailed review. Leaking other people's data is taken seriously from the first time.

This policy will change as the tools do. To suggest a change, open a [discussion](https://github.com/Sparklysparkspark/lifer-app/discussions).

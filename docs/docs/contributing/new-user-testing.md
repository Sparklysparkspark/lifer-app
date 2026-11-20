---
title: New-user testing
description: Run a session with someone who has never used Lifer, with five tasks, a consent note, what to watch for and how to write it up.
---

# New-user testing

Five people who have never used Lifer, five tasks each, about 45 minutes per person. You watch, they talk. Everything you need for a session is on this page.

## Before the session

- A computer with a fresh Lifer install (desktop app, or a new Docker server for someone who'll use a server). No account, no library, no downloaded regions.
- A folder of 30 to 50 of the tester's own wildlife photos, or a sample folder if they have none. Include a few RAWs and one video.
- Screen and audio recording ready, if they agree to it.
- A printed or second-screen copy of the task sheet below, and the observer checklist for you.
- Don't explain Lifer beforehand. "It's an app for wildlife photos" is enough.

## Consent note

Read this out, or hand it over, and get a yes before you start recording:

> Thanks for helping. I'm testing Lifer, not you: anything that's hard is Lifer's fault, and that's what I want to find.
>
> With your permission I'll record the screen and what you say. The recording stays on my computer, is only watched by me to improve Lifer, and I'll delete it within three months. Nothing is published, and your photos are never copied off this computer.
>
> You can stop at any time, skip any task, or ask me to delete the recording later.
>
> Is it OK to record? (Yes / No / Screen only, no voice)

Write down the answer on the findings sheet. If it's no, take notes only.

## Task sheet (give this to the tester)

Read each task, then do it the way you'd normally try. Please say out loud what you're looking for and what you expect to happen. There are no wrong answers.

1. **Get started.** Open Lifer and set it up so you can use it with your photos.
2. **Bring your photos in.** Add the photos in the folder you were given, and make sure each one is the right animal.
3. **Find a species.** Find out how many species you've photographed, and open the page for one of them.
4. **Find a photo.** Find your best photo of a bird (or any animal) in flight, without scrolling through everything.
5. **Make something to share.** Put three favourite photos together in an album, then delete one photo and get it back.

## Observer checklist (for you)

Don't help unless they're stuck for two minutes or ask to skip. If they ask a question, answer with "What would you expect?" and note it.

For each task, note:

- [ ] Time from start to done (or gave up).
- [ ] Done without help / done with a hint / not done.
- [ ] The first place they looked or clicked.
- [ ] Words they used for things (they may say "folder" where Lifer says "library").
- [ ] Any moment they hesitated more than about five seconds, and where.
- [ ] Anything they expected to happen that didn't.
- [ ] Any error message, blank page or spinner they waited on.
- [ ] What they said they liked.

After the five tasks, ask:

1. What was the most confusing moment?
2. What would you use Lifer for, if anything?
3. Is there anything you expected to find and didn't?
4. On a scale of 1 to 5, how easy was it overall?

## Findings template

Copy this once per tester.

```
Tester: (first name or T1 to T5)        Date:
System: Windows / macOS / Linux / server in a browser
Recording: yes / no / screen only
Photo experience: (e.g. "Lightroom for 10 years", "phone only")

Task 1 Get started:        time    result: done / hint / not done
  Notes:
Task 2 Bring photos in:    time    result:
  Notes:
Task 3 Find a species:     time    result:
  Notes:
Task 4 Find a photo:       time    result:
  Notes:
Task 5 Album and restore:  time    result:
  Notes:

Most confusing moment:
Would use it for:
Expected but missing:
Ease (1 to 5):
```

## After all five

- List every problem that two or more testers hit. Those come first.
- For each problem, write one line: what happened, which task, how many testers, and a screenshot or recording time.
- File each one as a package in the implementation plan, with the UX rule it breaks (see `docs/plans/ux-rules.md`) if there is one.
- Delete the recordings when you're done with them, and within three months at the latest.

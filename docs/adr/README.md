# Architecture decision records

One file per decision that is expensive to reverse. Name: `NNNN-short-title.md`, numbered in
order, never reused.

Each record has a title, then `Status`, `Date`, `Deciders` and optionally `Related`, followed by
**Context**, **Decision**, **Consequences**. Add **Order of work** when the decision is a plan.

Statuses: **Proposed** (written, not yet agreed), **Accepted**, **Superseded by NNNN**,
**Rejected**. A superseded record stays; only its status changes.

| # | Title | Status |
|---|---|---|
| [0001](0001-kurier-as-an-embeddable-widget.md) | kurier as an embeddable widget | Proposed |
| [0002](0002-assistant-in-continuous-operation.md) | The assistant in continuous operation | Accepted |

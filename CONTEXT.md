# Roark Domain Context

Roark coordinates repository-aware coding-agent workflows while keeping project guidance, workflow policy, and generated run state distinct.

## Language

**Repository Coding Preference**:
A project-owned, advisory tie-breaker between otherwise valid implementation choices. It may steer new code away from incidental legacy patterns, but yields to issue requirements, correctness, security, validation, workflow policy, and explicit repository instructions.
_Avoid_: Code taste, style rule

**Revision Feedback Item**:
A single concern considered during a PR revision. It has a stable identifier, identifies its GitHub source or sources, and receives exactly one planning classification.
_Avoid_: Plan item, feedback string

**Revision Feedback Disposition**:
The final outcome for one Revision Feedback Item. Every planned item has exactly one disposition, which records whether it was addressed, already addressed, needs human input, was not actionable, or was skipped, together with the reason or resolution.
_Avoid_: Addressed list, skipped list

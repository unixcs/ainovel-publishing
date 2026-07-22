# Plan against publication-day quota with configurable time slots

**Status: accepted**

The planner treats the current account limit as a publication-day quota with an initial effective limit of 9,999 units, reserves capacity for already verified schedules, refuses to split oversized chapters, and offers configurable `12:00`, `20:00`, and `22:00` slots in `Asia/Shanghai` with `20:00` as the default. This reflects the user's observed platform behavior while retaining separate observations for later calibration if Fanqie also enforces a submission-day limit.

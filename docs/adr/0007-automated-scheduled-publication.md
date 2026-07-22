# Allow automated scheduled publication after plan approval

**Status: accepted**

The workflow now permits the local Edge extension to complete the known Fanqie submission flow and create future scheduled publications after the user approves a publication plan. This supersedes the human-final-click boundary in ADR 0001 because the user explicitly chose full automation, while credentials, CAPTCHA/risk-control actions, unknown states, and version conflicts still require human intervention; keeping execution local avoids moving the logged-in platform session to the server.

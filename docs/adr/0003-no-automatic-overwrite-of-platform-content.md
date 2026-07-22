# Never automatically overwrite saved or published platform content

When the server hash changes after a chapter has been saved as a Fanqie draft or published, the workflow records a version conflict and presents a diff instead of overwriting the platform copy. This preserves human review at the point where an automated sync would otherwise change externally persisted or public content.

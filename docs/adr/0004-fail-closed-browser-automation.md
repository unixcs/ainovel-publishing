# Fail closed on unknown browser and platform state

The extension stops the current publishing attempt whenever page identity, editor structure, content validation, authentication, dialogs, connectivity, or the result of a remote mutation cannot be confirmed. It records the reason and waits for human intervention rather than guessing, retrying a save or publish action, or advancing to another chapter.

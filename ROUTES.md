Classify complexity. ONE word: super_easy, easy, medium, hard, super_hard
If message has "Context:", classify based on BOTH context and message combined.
Short follow-ups ("Yes", "Try now?") inherit complexity from context.

super_easy: standalone greetings only (hi, hey, thanks, bye) with NO context
easy: simple questions, reminders, status checks, formatting, simple facts
medium: write code, function, email, research, fix bug, any code generation
hard: refactor, debug crash, multi-file change, complex code, image analysis
super_hard: design system, design architecture, distributed, prove, autonomous, algorithms

RULE: "design" = super_hard, "refactor" = hard
RULE: short message + complex context = use context complexity

Examples:
"Hey" -> super_easy
"What is 2+2?" -> easy
"Write a sort function" -> medium
"Send email to Bob" -> medium
"Refactor the auth module" -> hard
"Design a distributed system" -> super_hard

Context examples:
"Context: Design a system\n---\nMessage: Try now?" -> super_hard
"Context: Write a function\n---\nMessage: Yes" -> medium
"Context: Hey how are you\n---\nMessage: Good thanks" -> super_easy

Message: {MESSAGE}
Complexity:

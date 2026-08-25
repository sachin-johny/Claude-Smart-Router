Classify complexity and clarity. Respond as: complexity|clarity

complexity: ONE word from: super_easy, easy, medium, hard, super_hard
clarity: "clear" or "ambiguous" (ambiguous = request is underspecified enough that a reasonable assistant would have to guess important details)

If message has "Context:", classify based on BOTH context and message combined.
Short follow-ups ("Yes", "Try now?") inherit complexity from context.

super_easy: standalone greetings only (hi, hey, thanks, bye) with NO context
easy: simple questions, reminders, status checks, formatting, simple facts
medium: write code, function, email, research, fix bug, any code generation
hard: refactor, debug crash, multi-file change, complex code, image analysis
super_hard: design system, design architecture, distributed, prove, autonomous, algorithms

RULE: "design a system/architecture" (verb + object) = super_hard; "what is a design system?" (question) = easy
RULE: "refactor the X" (verb + object) = hard; "what is refactor?" (question) = easy
RULE: short message + complex context = use context complexity
RULE: only mark ambiguous if it would genuinely change the work approach

Examples:
"Hey" -> super_easy|clear
"What is 2+2?" -> easy|clear
"What is a design system?" -> easy|clear
"Write a sort function" -> medium|clear
"Send email to Bob" -> medium|ambiguous
"Refactor the auth module" -> hard|clear
"Design a distributed system" -> super_hard|clear
"Fix the bug" -> medium|ambiguous

Context examples:
"Context: Design a system\n---\nMessage: Try now?" -> super_hard|clear
"Context: Write a function\n---\nMessage: Yes" -> medium|clear
"Context: Hey how are you\n---\nMessage: Good thanks" -> super_easy|clear

Message: {MESSAGE}
Complexity|Clarity:

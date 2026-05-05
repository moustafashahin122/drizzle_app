---
name: explain-in-a-human-way
description: |
  Use this skill when explaining code, systems, concepts, APIs, architecture, or other technical material to an intelligent person who is unfamiliar with the subject. Prioritize big picture first, then progressively deepen detail. Teach through cause-and-effect, mental models, and practical examples; avoid robotic, definition-only, or line-by-line paraphrasing. Also save the final explanation into a .md file under docs/ so it can be shared and revisited.
---

# Skill: Explain in a Human Way

When explaining code, systems, concepts, APIs, architecture, or technical material, teach it like you’re explaining to a smart colleague who’s new to this specific topic.

The explanation must be:

- easy to follow
- detailed
- technically accurate
- comprehensive
- natural and human sounding

## Goal

Help the reader build a usable mental model so that afterwards they can say:

“I understand what this does, why it exists, how it works, and what would happen if I changed something.”

## Rules

### 0. Save the explanation as a `.md` file

After writing the explanation in chat, also save the same explanation into a markdown file so it can be reused.

- Put it under `docs/` (create it if needed).
- Prefer `docs/explanations/` for multiple topics (create it if needed).
- Use a clear filename based on the topic, like `docs/explanations/<topic-slug>.md`.
- The file should contain the explanation content itself (not meta-instructions).

### 1. Start with the big picture

Begin with a simple explanation of:

- what this thing is
- why it exists
- what problem it solves

Before discussing syntax or implementation details, make the reader understand the purpose.

### 2. Explain progressively

Move from simple to detailed.

Use this order whenever possible:

1. intuitive overview
2. how it works conceptually
3. breakdown of important parts
4. practical meaning
5. edge cases or important technical notes

### 3. Explain like teaching, not defining

Don’t only give definitions.

Prefer:

- cause and effect
- what happens first, next, and why
- how pieces interact
- what the reader should imagine mentally

### 4. For code explanations

When explaining code:

- explain what the code is trying to accomplish first
- then explain the flow from top to bottom
- explain variables, functions, conditions, loops, and data movement
- explain why a line exists, not only what it does
- mention hidden behavior when relevant

Do not merely paraphrase code line by line.

### 5. Use simple language without becoming shallow

Prefer plain words over jargon.

If technical terms are necessary:

- introduce them naturally
- explain them immediately in simple words

### 6. Be detailed, but keep clarity

Include important details, but avoid unnecessary complexity.

The reader should finish with both:

- practical understanding
- conceptual understanding

### 7. Use examples when useful

If the concept is abstract, use a small realistic example or analogy.

Examples should clarify, not distract.

### 8. Assume curiosity

Anticipate questions a thoughtful reader would have, such as:

- why is it done this way?
- what happens if this changes?
- why not do it differently?

Answer these when relevant.

### 9. Avoid robotic explanation style

Do not sound like documentation.

Avoid:

- overly formal wording
- dictionary-like definitions
- vague summaries

Write as if you are explaining to a colleague sitting next to you.


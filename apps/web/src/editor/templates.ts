/**
 * Built-in note templates and custom template storage.
 */

export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  defaultTitle: string;
  content: string;
}

export const BUILTIN_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: "meeting",
    name: "Meeting Notes",
    description: "Capture attendees, discussion agenda, and action items.",
    defaultTitle: "Meeting: ",
    content: `## 📋 Overview
- **Date:** ${new Date().toISOString().slice(0, 10)}
- **Attendees:**
- **Agenda:**

---

## 💬 Discussion
1.

---

## ✅ Action Items
- [ ] Task 1 (@owner)
- [ ] Task 2 (@owner)
`,
  },
  {
    id: "daily",
    name: "Daily Note",
    description: "Track daily priorities, progress, and reflections.",
    defaultTitle: `Daily Note - ${new Date().toISOString().slice(0, 10)}`,
    content: `## 🎯 Today's Focus
1. 
2. 
3. 

---

## 📝 Log & Notes


---

## 💡 Review & Reflections
- **Wins:**
- **Learnings:**
`,
  },
  {
    id: "reading",
    name: "Book & Article Note",
    description: "Summarize reading notes, core arguments, and takeaways.",
    defaultTitle: "Reading: ",
    content: `## 📖 Metadata
- **Source / Author:** 
- **Status:** In Progress / Completed
- **Rating:** ⭐⭐⭐⭐⭐

---

## 💡 Key Takeaways
1. 

---

## 📑 Memorable Quotes
> 

---

## 🧠 Personal Reflections
`,
  },
  {
    id: "project",
    name: "Project Tracker",
    description: "Plan project goals, roadmap milestones, and tasks.",
    defaultTitle: "Project: ",
    content: `## 🚀 Objective & Scope


---

## 📅 Milestones
- [ ] M1: 
- [ ] M2: 

---

## 🛠️ Tasks
- [ ] 

---

## 🚧 Blockers & Risks
- None currently.
`,
  },
];

export const CUSTOM_TEMPLATES_KEY = "securenotes.custom-templates";

export function loadCustomTemplates(storage: {
  getItem: (k: string) => string | null;
}): NoteTemplate[] {
  try {
    const raw = storage.getItem(CUSTOM_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomTemplate(
  storage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void },
  template: NoteTemplate,
): NoteTemplate[] {
  const existing = loadCustomTemplates(storage);
  const updated = [...existing.filter((t) => t.id !== template.id), template];
  storage.setItem(CUSTOM_TEMPLATES_KEY, JSON.stringify(updated));
  return updated;
}

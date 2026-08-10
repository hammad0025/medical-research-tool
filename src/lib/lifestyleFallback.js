const conditionLabelFor = (condition) => String(condition || '').trim() || 'this condition'

// These are research questions, not lifestyle claims. They keep a report useful
// when the live source packet has not returned condition-specific lifestyle findings.
export const buildLifestyleFallbackTopics = (condition) => {
  const conditionLabel = conditionLabelFor(condition)

  return [
    {
      id: 'daily-function',
      title: 'Daily function and independence',
      summary: `For ${conditionLabel}, ask which daily activities, mobility needs, work or school tasks, and adaptive tools are most important to review.`,
      providerQuestion: 'Which daily activities or adaptive supports should we discuss for this condition?',
      caution: 'This is a topic to check, not a finding that every person with this condition needs the same support.',
      verificationQuery: `${conditionLabel} daily living quality of life`,
    },
    {
      id: 'activity-rehabilitation',
      title: 'Activity and rehabilitation',
      summary: `Ask whether a condition-specific activity plan, rehabilitation program, or physical, occupational, pulmonary, vision, or other therapist could help with ${conditionLabel}.`,
      providerQuestion: "Is there a safe activity or rehabilitation plan that fits this person's symptoms and limits?",
      caution: 'Do not start a new exercise or rehabilitation program from this card alone. The right plan depends on symptoms, safety risks, and current treatment.',
      verificationQuery: `${conditionLabel} rehabilitation physical activity`,
    },
    {
      id: 'sleep-fatigue-support',
      title: 'Sleep, fatigue, and emotional support',
      summary: `Ask whether sleep, fatigue, mood, stress, caregiver support, or counseling should be part of the care plan for ${conditionLabel}.`,
      providerQuestion: 'Which sleep, fatigue, or emotional-support needs should we bring up at the next visit?',
      caution: 'This is a care-planning question, not proof that any one support will improve the condition.',
      verificationQuery: `${conditionLabel} sleep fatigue mental health quality of life`,
    },
    {
      id: 'food-weight-swallowing',
      title: 'Food, weight, and swallowing',
      summary: `Ask whether appetite, weight change, nutrition, food safety, or swallowing needs special attention in this subtype or treatment plan for ${conditionLabel}.`,
      providerQuestion: 'Do food, weight, appetite, or swallowing changes matter for this condition or its treatment?',
      caution: "This does not mean a special diet is proven. A clinician or dietitian should check the person's situation before any major change.",
      verificationQuery: `${conditionLabel} nutrition weight swallowing`,
    },
    {
      id: 'environment-planning',
      title: 'Home, work, and environmental planning',
      summary: `Ask whether smoke, workplace exposures, heat or light, infection prevention, travel, or another environmental factor should be planned around for ${conditionLabel}.`,
      providerQuestion: 'Are there exposures, home changes, or travel precautions that matter for this condition?',
      caution: 'The relevant exposures vary by condition and person. This card is a prompt to verify, not a list of restrictions.',
      verificationQuery: `${conditionLabel} environmental exposure prevention`,
    },
  ].map((topic) => ({
    ...topic,
    sourceIds: [],
    needsVerification: true,
    generatedFallback: true,
  }))
}

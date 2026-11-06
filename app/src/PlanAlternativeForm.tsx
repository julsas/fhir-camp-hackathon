import { useMemo, useState } from 'react'
import { create, display, type CarePlan, type PatientRecord } from './fhir'
import { ALTERNATIVE_TEMPLATES, buildAlternative, findGaps } from './planAlternatives'

function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Creates a new treatment alternative (CarePlan, intent option) from a gap in the chart. */
export function PlanAlternativeForm({ record, onCreated }: { record: PatientRecord; onCreated: (carePlan: CarePlan) => Promise<void> }) {
  const gaps = useMemo(() => findGaps(record.toothStates, record.conditions), [record])
  const [tooth, setTooth] = useState<string>()
  const [templateKey, setTemplateKey] = useState(ALTERNATIVE_TEMPLATES[0]?.key)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const gap = gaps.find((g) => g.tooth === tooth) ?? gaps[0]
  const template = ALTERNATIVE_TEMPLATES.find((t) => t.key === templateKey)
  if (gaps.length === 0) return <p className="note">No missing tooth in the chart: no gap to plan for.</p>

  async function submit() {
    if (!gap || !template) return
    setBusy(true)
    setError(undefined)
    try {
      const created = await create<CarePlan>(buildAlternative({ patient: record.patient, gap, template, existing: record.carePlans, today: today() }))
      // Keep the form busy until the list shows the new plan, so the next one gets the next letter.
      await onCreated(created)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="app-new-plan" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <h3>Neue Alternative</h3>
      <label>
        Befund{' '}
        <select value={gap?.tooth ?? ''} onChange={(e) => setTooth(e.target.value)}>
          {gaps.map((g) => (
            <option key={g.tooth} value={g.tooth}>Zahn {g.tooth} fehlt{g.condition ? ` (${display(g.condition.code)})` : ''}</option>
          ))}
        </select>
      </label>
      <label>
        Versorgung{' '}
        <select value={templateKey ?? ''} onChange={(e) => setTemplateKey(e.target.value)}>
          {ALTERNATIVE_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>
      <button type="submit" disabled={busy || !gap || !template}>{busy ? 'Wird angelegt…' : 'Alternative anlegen'}</button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

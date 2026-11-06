// Minimal FHIR R4 access to the local Aidbox through the Vite proxy (/fhir).
// Only the fields the starter app reads are typed; add more as your task needs them.

export interface Coding { system?: string; code?: string; display?: string }
export interface CodeableConcept { coding?: Coding[]; text?: string }
export interface Reference { reference?: string; display?: string }
export interface Extension { url: string; valueCoding?: Coding; valueString?: string }

export interface Meta { profile?: string[]; versionId?: string; tag?: Coding[] }
export interface Resource { resourceType: string; id: string; meta?: Meta }

export interface Patient extends Resource {
  resourceType: 'Patient'
  name?: { family?: string; given?: string[]; text?: string }[]
  birthDate?: string
  gender?: string
}

export interface ObservationComponent {
  extension?: Extension[]
  code: CodeableConcept
  valueCodeableConcept?: CodeableConcept
}

export interface Observation extends Resource {
  resourceType: 'Observation'
  status: string
  code: CodeableConcept
  effectiveDateTime?: string
  bodySite?: CodeableConcept
  note?: { text: string }[]
  component?: ObservationComponent[]
  hasMember?: Reference[]
  valueCodeableConcept?: CodeableConcept
}

export interface Condition extends Resource {
  resourceType: 'Condition'
  code?: CodeableConcept
  bodySite?: CodeableConcept[]
  recordedDate?: string
  evidence?: { detail?: Reference[] }[]
}

export interface CarePlanActivity {
  detail?: {
    kind?: string
    code?: CodeableConcept
    status?: string
    reasonReference?: Reference[]
    description?: string
  }
}

export interface CarePlan extends Resource {
  resourceType: 'CarePlan'
  identifier?: { system?: string; value?: string }[]
  status: string
  intent: string
  category?: CodeableConcept[]
  title?: string
  description?: string
  subject?: Reference
  period?: { start?: string; end?: string }
  created?: string
  author?: Reference
  addresses?: Reference[]
  supportingInfo?: Reference[]
  activity?: CarePlanActivity[]
}

export interface ChargeItem extends Resource {
  resourceType: 'ChargeItem'
  status: string
  code: CodeableConcept
  bodysite?: CodeableConcept[]
  quantity?: { value?: number }
  factorOverride?: number
  supportingInformation?: Reference[]
  account?: Reference[]
}

interface Bundle<T> { entry?: { resource: T }[] }

async function failure(method: string, path: string, response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  let detail = ''
  try {
    const outcome = JSON.parse(text) as { issue?: { severity?: string; diagnostics?: string; details?: { text?: string } }[] }
    detail = (outcome.issue ?? []).map((i) => i.diagnostics ?? i.details?.text ?? '').filter(Boolean).join('; ')
  } catch { /* not an OperationOutcome */ }
  return new Error(`${method} /fhir/${path}: HTTP ${response.status}${detail ? ` (${detail})` : ''}`)
}

/** Creates a resource; the server assigns the id. */
export async function create<T extends Resource>(resource: Omit<T, 'id'>): Promise<T> {
  const path = resource.resourceType
  const response = await fetch(`/fhir/${path}`, {
    method: 'POST',
    headers: { accept: 'application/fhir+json', 'content-type': 'application/fhir+json' },
    body: JSON.stringify(resource),
  })
  if (!response.ok) throw await failure('POST', path, response)
  return (await response.json()) as T
}

/**
 * Updates several resources in one transaction: all or nothing. Each update carries the
 * version it was read at (If-Match), so a change made in between fails instead of being lost.
 */
export async function updateAll(resources: Resource[]): Promise<void> {
  if (resources.length === 0) return
  const bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((resource) => ({
      resource,
      request: {
        method: 'PUT',
        url: `${resource.resourceType}/${resource.id}`,
        ...(resource.meta?.versionId ? { ifMatch: `W/"${resource.meta.versionId}"` } : {}),
      },
    })),
  }
  const response = await fetch('/fhir', {
    method: 'POST',
    headers: { accept: 'application/fhir+json', 'content-type': 'application/fhir+json' },
    body: JSON.stringify(bundle),
  })
  if (!response.ok) throw await failure('POST', '', response)
}

export async function search<T extends Resource>(query: string): Promise<T[]> {
  const response = await fetch(`/fhir/${query}`, { headers: { accept: 'application/fhir+json' } })
  if (!response.ok) throw new Error(`GET /fhir/${query}: HTTP ${response.status}`)
  const bundle = (await response.json()) as Bundle<T>
  return (bundle.entry ?? []).map((entry) => entry.resource)
}

export interface PatientRecord {
  patient: Patient
  toothStates: Observation[]
  findings: Observation[]
  conditions: Condition[]
  carePlans: CarePlan[]
  chargeItems: ChargeItem[]
}

export const TOOTH_STATE_PROFILE = 'https://fhir.cognovis.de/dental-core/StructureDefinition/dental-tooth-state'
export const FDI_TOOTH_SYSTEM = 'https://fhir.cognovis.de/dental-core/CodeSystem/tooth-position-fdi'

export async function loadPatientRecord(patient: Patient): Promise<PatientRecord> {
  const subject = `Patient/${patient.id}`
  const [observations, conditions, carePlans, chargeItems] = await Promise.all([
    search<Observation>(`Observation?subject=${subject}&_count=500`),
    search<Condition>(`Condition?subject=${subject}&_count=100`),
    search<CarePlan>(`CarePlan?subject=${subject}&_count=100&_sort=_id`),
    search<ChargeItem>(`ChargeItem?subject=${subject}&_count=500&_sort=_id`),
  ])
  const isToothState = (o: Observation) => o.meta?.profile?.includes(TOOTH_STATE_PROFILE) ?? false
  return {
    patient,
    toothStates: latestPerTooth(observations.filter(isToothState)),
    findings: observations.filter((o) => !isToothState(o) && !o.hasMember),
    conditions,
    carePlans,
    chargeItems,
  }
}

export function toothOf(concept: CodeableConcept | undefined): string | undefined {
  return concept?.coding?.find((c) => c.system === FDI_TOOTH_SYSTEM)?.code
}

// One tooth-state Observation per tooth: the most recent effective date wins.
function latestPerTooth(observations: Observation[]): Observation[] {
  const byTooth = new Map<string, Observation>()
  for (const observation of observations) {
    const tooth = toothOf(observation.bodySite)
    if (!tooth) continue
    const current = byTooth.get(tooth)
    if (!current || (observation.effectiveDateTime ?? '') > (current.effectiveDateTime ?? '')) byTooth.set(tooth, observation)
  }
  return [...byTooth.values()]
}

export function patientName(patient: Patient): string {
  const name = patient.name?.[0]
  if (!name) return patient.id
  return name.text ?? [...(name.given ?? []), name.family].filter(Boolean).join(' ')
}

export function display(concept: CodeableConcept | undefined): string {
  return concept?.text ?? concept?.coding?.[0]?.display ?? concept?.coding?.[0]?.code ?? ''
}

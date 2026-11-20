// Shared defaults so the API, the seed script and the UI never drift apart.

export const DEFAULT_EXIT_REASONS = [
  'Crossed 3 NCs',
  'Late to college',
  'Imposition pending',
  'L1',
  'L2',
  'Irregular',
  'Medical reason',
  'To be suspended',
]

export const DEFAULT_ENTRY_SUBJECTS = [
  'BS',
  'ECO',
  'ENG',
  'KAN',
  'STATS',
  'ACC',
  'HIN',
  'All Subjects',
]

export const DEFAULT_BUS_CUTOFF = '08:20'

export const ROLE_LABELS = {
  superadmin: 'Super Admin',
  admin: 'Admin / Coordinator',
  teacher: 'Class Teacher',
  transport: 'Transport In-charge',
  leader: 'Class Leader',
  gate: 'Gate / Security',
}

// Local (not UTC) calendar date, YYYY-MM-DD.
export const todayIso = () => new Date().toLocaleDateString('en-CA')

// Deal with the "Sunday has no school" rule in one place.
export const isSchoolDay = (iso) => new Date(`${iso}T00:00:00`).getDay() !== 0


export enum EventType {
  COMPRESSIONS_START = 'Compressions Started',
  SHOCK_DELIVERED = 'Shock Delivered',
  EPINEPHRINE_ADMINISTERED = 'Epinephrine',
  AMIODARONE_ADMINISTERED = 'Amiodarone',
  LIDOCAINE_ADMINISTERED = 'Lidocaine',
  OTHER_MEDICATION = 'Other Medication',
  NURSE_NOTE = 'Nurse\'s Note',
  UNDO_LAST_ACTION = 'Undo Last Action',
  RHYTHM_CHECK_ROSC = 'Rhythm Check: ROSC',
  RHYTHM_CHECK_PULSELESS = 'Rhythm Check: Pulseless',
  RHYTHM_ANALYZED = 'Rhythm Analyzed',
  CHECKLIST_UPDATE = 'Checklist Update',
}

export interface EventLogItem {
  id: string;
  type: EventType;
  timestamp: number; // elapsed seconds from start
  details?: string; // e.g., "200J Biphasic", "Lidocaine 100mg IV"
  actor?: string; // e.g., "By: Nurse Casey"
  medicationName?: string; // For OTHER_MEDICATION type
}

export interface MedicationPrefill {
  name: string;
  dose: string;
  eventType: EventType.EPINEPHRINE_ADMINISTERED | EventType.AMIODARONE_ADMINISTERED | EventType.LIDOCAINE_ADMINISTERED | EventType.OTHER_MEDICATION;
}

export interface ModalState {
  isOpen: boolean;
  type: 'shock' | 'medication' | 'note' | 'rhythm-classification' | 'hs-and-ts' | 'initial-rhythm' | 'cdss-recommendation' | null;
  prefill?: MedicationPrefill;
}

export type CodeStatus = 'inactive' | 'active' | 'review' | 'history_view';

export interface AlgorithmState {
  path: 'shockable' | 'non-shockable' | null;
  step: number; // Represents the current position in the algorithm path
}

export interface HsandTs {
    hypovolemia: boolean;
    hypoxia: boolean;
    hydrogenIon: boolean;
    hypoHyperkalemia: boolean;
    hypothermia: boolean;
    tensionPneumothorax: boolean;
    tamponade: boolean;
    toxins: boolean;
    thrombosisPulmonary: boolean;
    thrombosisCoronary: boolean;
}

export interface PatientDetails {
    hn: string;
    name: string;
    age: string;
    sex: string; // 'M', 'F', or other
    history: string;
    diagnosis: string;
}

export interface SavedCodeRecord {
    id: string;
    date: string;
    startTime: number;
    elapsedTime: number;
    patientDetails: PatientDetails;
    summaryCounts: AppState['summaryCounts'];
    events: EventLogItem[];
    outcome: 'ROSC' | 'Ceased' | 'Unknown';
}

export interface AppState {
  codeStatus: CodeStatus;
  startTime: number | null; // Date.now() timestamp
  elapsedTime: number; // in seconds
  events: EventLogItem[];
  timers: {
    rhythmCheck: number | null; // countdown in seconds
    epinephrine: number | null; // countdown in seconds
  };
  timerSettings: {
    rhythmCheck: number; // in seconds
    epinephrine: number; // in seconds
  };
  summaryCounts: {
    shocks: number;
    epinephrine: number;
    amiodarone: number; // Total mg
    lidocaine: number; // Total mg
    otherMedications: { [key: string]: number };
  };
  reversibleCauses: HsandTs;
  patientDetails: PatientDetails;
  showRhythmAlert: boolean;
  showPrepareEpiAlert: boolean;
  epinephrineDue: boolean;
  lastShockEnergy: string | null;
  modal: ModalState;
  suggestions: {
    isLoading: boolean;
    error: string | null;
    data: string[];
  };
  algorithmState: AlgorithmState;
  // A copy of the state before the last action, for the undo functionality
  previousState: Partial<AppState> | null;
  lastCompressionStop: number | null; // Timestamp when compressions stopped
  showNoFlowAlert: boolean;
  viewingHistoryRecord: SavedCodeRecord | null; // For reviewing past codes
}

export type Action =
  | { type: 'START_CODE' }
  | { type: 'END_CODE' }
  | { type: 'RESET_APP' }
  | { type: 'TICK' }
  | { type: 'LOG_EVENT'; payload: { type: EventType; details?: string; actor?: string; medicationName?: string } }
  | { type: 'DISMISS_RHYTHM_ALERT' }
  | { type: 'DISMISS_PREPARE_EPI_ALERT' }
  | { type: 'DISMISS_EPINEPHRINE_DUE_ALERT' }
  | { type: 'OPEN_MODAL'; payload: { type: ModalState['type']; prefill?: MedicationPrefill } }
  | { type: 'CLOSE_MODAL' }
  | { type: 'UNDO_LAST_ACTION' }
  | { type: 'LOAD_STATE'; payload: AppState }
  | { type: 'DELETE_EVENT'; payload: { id: string } }
  | { type: 'FETCH_SUGGESTIONS_START' }
  | { type: 'FETCH_SUGGESTIONS_SUCCESS'; payload: string[] }
  | { type: 'FETCH_SUGGESTIONS_FAILURE'; payload: string }
  | { type: 'UPDATE_TIMER_SETTING'; payload: { timer: 'rhythmCheck' | 'epinephrine'; value: number } }
  | { type: 'SET_ALGORITHM_PATH'; payload: { path: 'shockable' | 'non-shockable' } }
  | { type: 'TOGGLE_H_T'; payload: { cause: keyof HsandTs } }
  | { type: 'UPDATE_PATIENT_DETAILS'; payload: Partial<PatientDetails> }
  | { type: 'VIEW_HISTORY_RECORD'; payload: SavedCodeRecord }
  | { type: 'CLOSE_HISTORY_VIEW' };

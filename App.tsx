
import React, { useReducer, useEffect, useCallback, useState, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { AppState, Action, EventType, EventLogItem, ModalState, CodeStatus, HsandTs, PatientDetails, SavedCodeRecord } from './types';
import { 
  HeartbeatIcon, PlayIcon, BoltIcon, SyringeIcon, ClockIcon, ChartBarIcon, 
  ListBulletIcon, PlusIcon, ArrowUturnLeftIcon, BellAlertIcon, XMarkIcon,
  CheckCircleIcon, XCircleIcon, Cog6ToothIcon, MicrophoneIcon, SparklesIcon,
  PencilIcon, StopCircleIcon, UserIcon, ChevronDownIcon, ChevronUpIcon, ArrowDownTrayIcon,
  ArchiveBoxIcon, EyeIcon, LockClosedIcon, ArrowLeftIcon
} from './components/icons';

const CPR_STATE_KEY = 'cprTrackRecordState';
const CPR_HISTORY_KEY = 'cprTrackHistory';

// Helper Functions
const formatTime = (totalSeconds: number): string => {
  if (totalSeconds < 0) totalSeconds = 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatTimeSecondary = (totalSeconds: number): string => {
  if (totalSeconds < 0) totalSeconds = 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatRelativeTime = (elapsedSeconds: number, startTime: number | null): string => {
  if (startTime === null) return '';
  const eventTime = startTime + elapsedSeconds * 1000;
  const now = Date.now();
  const diffSeconds = Math.round((now - eventTime) / 1000);

  if (diffSeconds < 60) return `${diffSeconds} sec ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  return `${diffMinutes} min ago`;
};

const blobToBase64 = (blob: globalThis.Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === 'string') {
                const base64Data = reader.result.split(',')[1];
                resolve(base64Data);
            } else {
                reject(new Error("Failed to read blob as base64 string"));
            }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
};

const parseDose = (doseStr: string): number => {
    const match = doseStr.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
};

const saveCodeToHistory = (state: AppState) => {
    try {
        const historyJSON = localStorage.getItem(CPR_HISTORY_KEY);
        const history: SavedCodeRecord[] = historyJSON ? JSON.parse(historyJSON) : [];
        
        // Determine outcome based on last rhythm check or simple heuristic
        const lastEvent = state.events[0];
        let outcome: 'ROSC' | 'Ceased' | 'Unknown' = 'Unknown';
        if (lastEvent && lastEvent.type === EventType.RHYTHM_CHECK_ROSC) {
            outcome = 'ROSC';
        }

        const newRecord: SavedCodeRecord = {
            id: Date.now().toString(),
            date: new Date().toISOString(),
            startTime: state.startTime || Date.now(),
            elapsedTime: state.elapsedTime,
            patientDetails: state.patientDetails,
            summaryCounts: state.summaryCounts,
            events: state.events,
            outcome: outcome
        };

        history.push(newRecord);
        localStorage.setItem(CPR_HISTORY_KEY, JSON.stringify(history));
        console.log("Code auto-saved to history.");
    } catch (error) {
        console.error("Failed to auto-save code history:", error);
    }
};

const getLastSavedHistoryRecord = (): SavedCodeRecord | null => {
    try {
        const historyJSON = localStorage.getItem(CPR_HISTORY_KEY);
        if (!historyJSON) return null;
        const history: SavedCodeRecord[] = JSON.parse(historyJSON);
        return history.length > 0 ? history[history.length - 1] : null;
    } catch (e) {
        return null;
    }
};

// Reducer
const initialState: AppState = {
  codeStatus: 'inactive',
  startTime: null,
  elapsedTime: 0,
  events: [],
  timers: { rhythmCheck: null, epinephrine: null },
  timerSettings: {
    rhythmCheck: 120, // 2 minutes
    epinephrine: 180, // 3 minutes
  },
  summaryCounts: { shocks: 0, epinephrine: 0, amiodarone: 0, lidocaine: 0, otherMedications: {} },
  reversibleCauses: {
    hypovolemia: false, hypoxia: false, hydrogenIon: false, hypoHyperkalemia: false, hypothermia: false,
    tensionPneumothorax: false, tamponade: false, toxins: false, thrombosisPulmonary: false, thrombosisCoronary: false
  },
  patientDetails: { hn: '', name: '', age: '', sex: '', history: '', diagnosis: '' },
  showRhythmAlert: false,
  showPrepareEpiAlert: false,
  epinephrineDue: false,
  lastShockEnergy: null,
  modal: { isOpen: false, type: null },
  suggestions: { isLoading: false, error: null, data: [] },
  algorithmState: { path: null, step: 0 },
  previousState: null,
  lastCompressionStop: null,
  showNoFlowAlert: false,
  viewingHistoryRecord: null,
};

const appReducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'START_CODE':
      return {
        ...initialState,
        codeStatus: 'active',
        startTime: Date.now(),
        lastCompressionStop: Date.now(), // Compressions start as stopped
        previousState: null, 
        suggestions: { isLoading: false, error: null, data: [] }, 
        modal: { isOpen: true, type: 'initial-rhythm' } 
      };
    case 'END_CODE':
      return { ...state, codeStatus: 'review', timers: { rhythmCheck: null, epinephrine: null }, showPrepareEpiAlert: false, showRhythmAlert: false, epinephrineDue: false, showNoFlowAlert: false };
    case 'RESET_APP':
        localStorage.removeItem(CPR_STATE_KEY);
        return initialState;
    case 'TICK': {
      if (state.codeStatus !== 'active' || !state.startTime) return state;
      const elapsedTime = (Date.now() - state.startTime) / 1000;
      let newRhythmCheck = state.timers.rhythmCheck !== null ? state.timers.rhythmCheck - 1 : null;
      let newEpinephrine = state.timers.epinephrine !== null ? state.timers.epinephrine - 1 : null;
      let showRhythmAlert = state.showRhythmAlert;
      let showPrepareEpiAlert = state.showPrepareEpiAlert;
      let epinephrineDue = state.epinephrineDue;
      let showNoFlowAlert = state.showNoFlowAlert;

      if (newRhythmCheck !== null && newRhythmCheck <= 0) {
        newRhythmCheck = 0;
        showRhythmAlert = true;
      }
      if (newEpinephrine !== null && newEpinephrine <= 0) {
        newEpinephrine = 0;
        showPrepareEpiAlert = false;
        epinephrineDue = true;
      }
      
      if (newEpinephrine === 60) {
        showPrepareEpiAlert = true;
      }

      // No-Flow Safety Check
      // If compressions are NOT active (rhythm timer is null) AND we are active
      if (newRhythmCheck === null && state.codeStatus === 'active') {
          // Ensure we have a stop time tracked
          if (state.lastCompressionStop) {
              const diff = Date.now() - state.lastCompressionStop;
              if (diff > 15000) { // 15 seconds
                  // Don't show if we just achieved ROSC (check last event)
                  const lastEventType = state.events[0]?.type;
                  if (lastEventType !== EventType.RHYTHM_CHECK_ROSC) {
                       showNoFlowAlert = true;
                  }
              }
          }
      } else {
          showNoFlowAlert = false;
      }

      return { ...state, elapsedTime, timers: { rhythmCheck: newRhythmCheck, epinephrine: newEpinephrine }, showRhythmAlert, showPrepareEpiAlert, epinephrineDue, showNoFlowAlert };
    }
    case 'LOG_EVENT': {
      const { type, details, actor, medicationName } = action.payload;
      const newEvent: EventLogItem = {
        id: Date.now().toString(),
        type,
        timestamp: state.elapsedTime,
        details,
        actor: actor || 'System',
        medicationName,
      };
      
      const stateBeforeLog = { ...state };
      const newState: AppState = { ...state, events: [newEvent, ...state.events] };
      let advanceAlgorithm = false;

      // Update summaries and timers based on event
      switch(type) {
        case EventType.COMPRESSIONS_START:
          if(newState.timers.rhythmCheck === null || newState.timers.rhythmCheck <= 0) newState.timers.rhythmCheck = state.timerSettings.rhythmCheck;
          newState.lastCompressionStop = null;
          newState.showNoFlowAlert = false;
          break;
        case EventType.SHOCK_DELIVERED:
          newState.summaryCounts.shocks += 1;
          newState.lastShockEnergy = details || null;
          if (newState.algorithmState.path === 'shockable') advanceAlgorithm = true;
          break;
        case EventType.EPINEPHRINE_ADMINISTERED:
          newState.summaryCounts.epinephrine += 1;
          newState.timers.epinephrine = state.timerSettings.epinephrine; // 3 minutes
          newState.showPrepareEpiAlert = false;
          newState.epinephrineDue = false;
          if (newState.algorithmState.path) advanceAlgorithm = true;
          break;
        case EventType.AMIODARONE_ADMINISTERED:
          newState.summaryCounts.amiodarone += parseDose(details || '0');
          if (newState.algorithmState.path === 'shockable') advanceAlgorithm = true;
          break;
        case EventType.LIDOCAINE_ADMINISTERED:
            newState.summaryCounts.lidocaine += parseDose(details || '0');
            if (newState.algorithmState.path === 'shockable') advanceAlgorithm = true;
            break;
        case EventType.OTHER_MEDICATION: {
          const medName = action.payload.medicationName || (details ? details.split(' ')[0] : 'Unknown');
          if (medName !== 'Unknown') {
            newState.summaryCounts.otherMedications[medName] = (newState.summaryCounts.otherMedications[medName] || 0) + 1;
          }
          break;
        }
        case EventType.RHYTHM_CHECK_ROSC:
            newState.algorithmState = { path: null, step: 0 }; // End algorithm on ROSC
            newState.timers.rhythmCheck = null; // Stop timer post-ROSC
            newState.showRhythmAlert = false;
            newState.lastCompressionStop = Date.now();
            break;
        case EventType.RHYTHM_CHECK_PULSELESS:
          // This event is now a precursor to classification. It should dismiss the alert.
          newState.showRhythmAlert = false;
          newState.timers.rhythmCheck = null; 
          newState.lastCompressionStop = Date.now();
          break;
        case EventType.RHYTHM_ANALYZED:
            newState.showRhythmAlert = false;
            newState.timers.rhythmCheck = null; 
            newState.lastCompressionStop = Date.now();
            break;
      }

      if (advanceAlgorithm && newState.algorithmState.path) {
          newState.algorithmState.step += 1;
      }
      
      newState.previousState = {...stateBeforeLog, previousState: null}; 
      return newState;
    }
    case 'DELETE_EVENT': {
      const { id } = action.payload;
      if (!state.events.find(e => e.id === id)) return state;
      
      const stateBeforeDelete = { ...state };
      const newEvents = state.events.filter(event => event.id !== id);
      
      const newSummaryCounts: AppState['summaryCounts'] = { shocks: 0, epinephrine: 0, amiodarone: 0, lidocaine: 0, otherMedications: {} };
      let newLastShockEnergy: string | null = null;
      
      for (const event of [...newEvents].reverse()) {
          switch(event.type) {
              case EventType.SHOCK_DELIVERED:
                  newSummaryCounts.shocks += 1;
                  newLastShockEnergy = event.details || null;
                  break;
              case EventType.EPINEPHRINE_ADMINISTERED:
                  newSummaryCounts.epinephrine += 1;
                  break;
              case EventType.AMIODARONE_ADMINISTERED:
                  newSummaryCounts.amiodarone += parseDose(event.details || '0');
                  break;
              case EventType.LIDOCAINE_ADMINISTERED:
                  newSummaryCounts.lidocaine += parseDose(event.details || '0');
                  break;
              case EventType.OTHER_MEDICATION: {
                  if (event.medicationName) {
                      newSummaryCounts.otherMedications[event.medicationName] = (newSummaryCounts.otherMedications[event.medicationName] || 0) + 1;
                  }
                  break;
              }
          }
      }

      return {
        ...state,
        events: newEvents,
        summaryCounts: newSummaryCounts,
        lastShockEnergy: newLastShockEnergy,
        previousState: {...stateBeforeDelete, previousState: null},
      };
    }
    case 'DISMISS_RHYTHM_ALERT':
      return { ...state, showRhythmAlert: false, timers: { ...state.timers, rhythmCheck: null }, lastCompressionStop: Date.now() };
    case 'DISMISS_PREPARE_EPI_ALERT':
      return { ...state, showPrepareEpiAlert: false };
    case 'DISMISS_EPINEPHRINE_DUE_ALERT':
      // Dismissing the alert is an action to defer, so we reset the timer.
      return { ...state, epinephrineDue: false, timers: { ...state.timers, epinephrine: state.timerSettings.epinephrine } };
    case 'OPEN_MODAL':
      return { ...state, modal: { isOpen: true, type: action.payload.type, prefill: action.payload.prefill } };
    case 'CLOSE_MODAL':
      return { ...state, modal: { isOpen: false, type: null } };
    case 'UNDO_LAST_ACTION':
      if (state.previousState) {
        return { ...(state.previousState as AppState) };
      }
      return state;
    case 'FETCH_SUGGESTIONS_START':
        return { ...state, suggestions: { isLoading: true, error: null, data: [] } };
    case 'FETCH_SUGGESTIONS_SUCCESS':
        return { ...state, suggestions: { isLoading: false, error: null, data: action.payload } };
    case 'FETCH_SUGGESTIONS_FAILURE':
        return { ...state, suggestions: { isLoading: false, error: action.payload, data: [] } };
    case 'UPDATE_TIMER_SETTING':
      return {
        ...state,
        timerSettings: {
          ...state.timerSettings,
          [action.payload.timer]: action.payload.value,
        },
        previousState: {...state, previousState: null}
      };
    case 'SET_ALGORITHM_PATH': {
        const details = action.payload.path === 'shockable' ? 'Rhythm is VF/pVT (Shockable)' : 'Rhythm is Asystole/PEA (Non-shockable)';
        const event: EventLogItem = {
            id: Date.now().toString(),
            type: EventType.RHYTHM_ANALYZED,
            timestamp: state.elapsedTime,
            details,
            actor: 'System',
        };
        return {
            ...state,
            algorithmState: { path: action.payload.path, step: 1 },
            events: [event, ...state.events],
            modal: { isOpen: true, type: 'cdss-recommendation' }, 
            showRhythmAlert: false,
            timers: { ...state.timers, rhythmCheck: null },
            lastCompressionStop: Date.now(),
            previousState: {...state, previousState: null}
        };
    }
    case 'TOGGLE_H_T':
        return {
            ...state,
            reversibleCauses: {
                ...state.reversibleCauses,
                [action.payload.cause]: !state.reversibleCauses[action.payload.cause]
            }
        };
    case 'UPDATE_PATIENT_DETAILS':
        return {
            ...state,
            patientDetails: {
                ...state.patientDetails,
                ...action.payload
            }
        };
    case 'LOAD_STATE':
        return {
            ...initialState,
            ...action.payload,
            algorithmState: action.payload.algorithmState || { path: null, step: 0 },
            epinephrineDue: action.payload.epinephrineDue || false,
            reversibleCauses: action.payload.reversibleCauses || initialState.reversibleCauses,
            lastCompressionStop: action.payload.lastCompressionStop || null,
            patientDetails: action.payload.patientDetails || initialState.patientDetails,
            showNoFlowAlert: false,
            showRhythmAlert: false,
            showPrepareEpiAlert: false,
            // IMPORTANT: Recalculate elapsed time to avoid stale state from local storage
            elapsedTime: action.payload.codeStatus === 'active' && action.payload.startTime 
                         ? (Date.now() - action.payload.startTime) / 1000 
                         : action.payload.elapsedTime,
        };
    case 'VIEW_HISTORY_RECORD':
        return {
            ...state,
            viewingHistoryRecord: action.payload,
            codeStatus: 'history_view'
        };
    case 'CLOSE_HISTORY_VIEW':
        return {
            ...state,
            viewingHistoryRecord: null,
            codeStatus: 'inactive'
        };
    default:
      return state;
  }
};

// UI Components
const Card: React.FC<{ children: React.ReactNode, className?: string, title?: string, icon?: React.ReactNode }> = ({ children, className, title, icon }) => (
  <div className={`bg-brand-card rounded-lg p-4 flex flex-col ${className}`}>
    {title && (
      <div className="flex items-center text-slate-300 mb-4">
        {icon}
        <h2 className="text-lg font-semibold ml-2">{title}</h2>
      </div>
    )}
    {children}
  </div>
);

const Header = React.memo(({ onEndCode, codeStatus, patientDetails, onOpenSettings }: { onEndCode: () => void, codeStatus: CodeStatus, patientDetails?: PatientDetails, onOpenSettings: () => void }) => (
  <header className="flex items-center justify-between p-4 bg-brand-card rounded-lg mb-6">
    <div className="flex items-center">
      <HeartbeatIcon className="h-8 w-8" />
      <h1 className="text-2xl font-bold ml-3 text-red-500">BPK CPR Tracker</h1>
      <span className="text-sm text-slate-400 ml-3 mt-1">ACLS Guided Workflow</span>
    </div>
    <div className="flex items-center space-x-6">
      <div className="text-right">
        <div className="text-slate-400 text-sm">Patient ID (HN)</div>
        <div className="font-mono text-lg">{patientDetails?.hn || '---'}</div>
      </div>
      <div className="text-right">
        <div className="text-slate-400 text-sm">Location</div>
        <div className="font-mono text-lg">ICU Room 314</div>
      </div>
      {codeStatus === 'active' && <button onClick={onEndCode} className="bg-brand-accent-red hover:bg-red-700 text-white font-bold py-2 px-4 rounded-lg transition-colors">End Code</button>}
      <button onClick={onOpenSettings} className="text-slate-400 hover:text-white p-2 rounded-full hover:bg-brand-subtle transition-colors">
        <Cog6ToothIcon className="h-6 w-6" />
      </button>
    </div>
  </header>
));

const PatientInfo = React.memo(({ details, dispatch }: { details: PatientDetails, dispatch: React.Dispatch<Action> }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [formData, setFormData] = useState(details);

    useEffect(() => {
        setFormData(details);
    }, [details]);

    const handleSave = () => {
        dispatch({ type: 'UPDATE_PATIENT_DETAILS', payload: formData });
        setIsEditing(false);
    };

    const toggleExpand = () => setIsExpanded(!isExpanded);
    
    const commonDiagnoses = ['ACS', 'Resp. Failure', 'Sepsis', 'Stroke', 'Trauma', 'Overdose', 'Metabolic', 'Unknown'];

    return (
        <div className="bg-brand-card rounded-lg mb-6 overflow-hidden border border-brand-subtle/50">
            <div className="flex items-center justify-between p-4 bg-brand-subtle/20 cursor-pointer hover:bg-brand-subtle/30 transition-colors" onClick={toggleExpand}>
                <div className="flex items-center">
                    <UserIcon className="h-5 w-5 text-slate-400 mr-3" />
                    <h2 className="font-semibold text-slate-200">Patient Details</h2>
                    {!isExpanded && (
                        <span className="ml-4 text-sm text-slate-400">
                            {details.hn ? `HN: ${details.hn}` : 'No HN'}
                            {details.name && ` • ${details.name}`}
                            {details.diagnosis && ` • Dx: ${details.diagnosis}`}
                        </span>
                    )}
                </div>
                <button className="text-slate-400 hover:text-white">
                    {isExpanded ? <ChevronUpIcon className="h-5 w-5" /> : <ChevronDownIcon className="h-5 w-5" />}
                </button>
            </div>
            
            {isExpanded && (
                <div className="p-4 border-t border-brand-subtle/50 animate-fade-in">
                    {isEditing ? (
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                             <div className="md:col-span-1">
                                <label className="block text-xs text-slate-400 mb-1">HN</label>
                                <input 
                                    type="text" 
                                    value={formData.hn} 
                                    onChange={e => setFormData({...formData, hn: e.target.value})}
                                    className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-sm text-white focus:border-brand-accent-blue outline-none font-mono"
                                    placeholder="Hospital Number"
                                />
                            </div>
                            <div className="md:col-span-1">
                                <label className="block text-xs text-slate-400 mb-1">Name</label>
                                <input 
                                    type="text" 
                                    value={formData.name} 
                                    onChange={e => setFormData({...formData, name: e.target.value})}
                                    className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-sm text-white focus:border-brand-accent-blue outline-none"
                                    placeholder="Patient Name"
                                />
                            </div>
                            <div className="md:col-span-1">
                                <label className="block text-xs text-slate-400 mb-1">Age</label>
                                <input 
                                    type="text" 
                                    value={formData.age} 
                                    onChange={e => setFormData({...formData, age: e.target.value})}
                                    className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-sm text-white focus:border-brand-accent-blue outline-none"
                                    placeholder="Age"
                                />
                            </div>
                            <div className="md:col-span-1">
                                <label className="block text-xs text-slate-400 mb-1">Sex</label>
                                <div className="flex gap-2 h-[38px]">
                                    <button
                                        onClick={() => setFormData({...formData, sex: 'Male'})}
                                        className={`flex-1 text-sm rounded border transition-colors ${formData.sex === 'Male' ? 'bg-brand-accent-blue border-brand-accent-blue text-white font-semibold' : 'bg-brand-dark border-brand-subtle text-slate-400 hover:border-slate-400'}`}
                                    >
                                        Male
                                    </button>
                                    <button
                                        onClick={() => setFormData({...formData, sex: 'Female'})}
                                        className={`flex-1 text-sm rounded border transition-colors ${formData.sex === 'Female' ? 'bg-brand-accent-blue border-brand-accent-blue text-white font-semibold' : 'bg-brand-dark border-brand-subtle text-slate-400 hover:border-slate-400'}`}
                                    >
                                        Female
                                    </button>
                                </div>
                            </div>
                            
                            <div className="md:col-span-4">
                                <label className="block text-xs text-slate-400 mb-1">Primary Diagnosis / Impression</label>
                                <div className="space-y-2">
                                    <input 
                                        type="text" 
                                        value={formData.diagnosis} 
                                        onChange={e => setFormData({...formData, diagnosis: e.target.value})}
                                        className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-sm text-white focus:border-brand-accent-blue outline-none"
                                        placeholder="e.g., Acute Coronary Syndrome"
                                    />
                                    <div className="flex flex-wrap gap-2">
                                        {commonDiagnoses.map(dx => (
                                            <button
                                                key={dx}
                                                onClick={() => setFormData({...formData, diagnosis: dx})}
                                                className="text-xs bg-brand-subtle hover:bg-brand-accent-blue text-slate-300 hover:text-white px-2 py-1 rounded transition-colors border border-brand-subtle"
                                            >
                                                {dx}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="md:col-span-4">
                                <label className="block text-xs text-slate-400 mb-1">Medical History</label>
                                <textarea 
                                    value={formData.history} 
                                    onChange={e => setFormData({...formData, history: e.target.value})}
                                    className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-sm text-white focus:border-brand-accent-blue outline-none"
                                    placeholder="Relevant medical history..."
                                    rows={2}
                                />
                            </div>
                            <div className="md:col-span-4 flex justify-end gap-2 mt-2">
                                <button onClick={() => { setIsEditing(false); setFormData(details); }} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
                                <button onClick={handleSave} className="px-4 py-2 text-sm bg-brand-accent-blue hover:bg-blue-600 text-white rounded font-semibold">Save Details</button>
                            </div>
                        </div>
                    ) : (
                        <div className="relative">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                 <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">HN</p>
                                    <p className="font-semibold text-lg font-mono">{details.hn || '—'}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Name</p>
                                    <p className="font-semibold text-lg">{details.name || '—'}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Age / Sex</p>
                                    <p className="font-semibold text-lg">{details.age || '—'} <span className="text-slate-500 mx-1">/</span> {details.sex || '—'}</p>
                                </div>
                                <div>
                                    <p className="text-xs text-slate-500 uppercase tracking-wide">Diagnosis</p>
                                    <p className="font-semibold text-lg text-yellow-400">{details.diagnosis || '—'}</p>
                                </div>
                                <div className="md:col-span-4">
                                     <p className="text-xs text-slate-500 uppercase tracking-wide">Medical History</p>
                                     <p className="text-slate-300">{details.history || 'No history recorded.'}</p>
                                </div>
                            </div>
                            <button 
                                onClick={() => setIsEditing(true)}
                                className="absolute top-0 right-0 p-2 text-slate-400 hover:text-brand-accent-blue transition-colors"
                                title="Edit Details"
                            >
                                <PencilIcon className="h-5 w-5" />
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});

const PrepareEpiAlert: React.FC<{ dispatch: React.Dispatch<Action> }> = ({ dispatch }) => (
    <div className="fixed top-24 left-1/2 -translate-x-1/2 z-40 bg-brand-accent-blue text-white p-3 rounded-lg shadow-2xl flex items-center">
        <BellAlertIcon className="h-6 w-6 mr-3"/>
        <div className="font-semibold text-lg mr-5">Prepare Next Epinephrine Dose</div>
        <button
            onClick={() => dispatch({ type: 'DISMISS_PREPARE_EPI_ALERT' })}
            className="bg-blue-800/50 hover:bg-blue-800/80 text-sm font-semibold py-1 px-3 rounded-md transition-colors"
        >
            Dismiss
        </button>
    </div>
);

const EventRecording = React.memo(({ 
    dispatch, 
    lastShockEnergy, 
    timers, 
    summaryCounts, 
    showNoFlowAlert 
}: { 
    dispatch: React.Dispatch<Action>, 
    lastShockEnergy: string | null,
    timers: AppState['timers'],
    summaryCounts: AppState['summaryCounts'],
    showNoFlowAlert: boolean
}) => {
  const log = useCallback((type: EventType, details?: string) => dispatch({ type: 'LOG_EVENT', payload: { type, details, actor: 'By: Nurse Casey' } }), [dispatch]);

  const isCompressionsActive = timers.rhythmCheck !== null && timers.rhythmCheck > 0;
  const amioMaxReached = summaryCounts.amiodarone >= 450;
  const lidoMaxReached = summaryCounts.lidocaine >= 300;

  return (
    <Card title="Manual Event Recording" icon={<ListBulletIcon className="h-6 w-6"/>}>
      {showNoFlowAlert && (
          <div className="mb-4 bg-red-600/90 border-l-4 border-white text-white p-4 rounded shadow-lg animate-pulse flex items-center justify-between">
              <div className="flex items-center">
                  <BellAlertIcon className="h-8 w-8 mr-3"/>
                  <div>
                      <p className="font-extrabold text-lg">NO FLOW DETECTED {'>'} 15s</p>
                      <p className="text-sm">Resume compressions immediately!</p>
                  </div>
              </div>
          </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <button 
            onClick={() => log(EventType.COMPRESSIONS_START)}
            disabled={isCompressionsActive}
            className={`bg-brand-accent-green hover:opacity-90 transition-all text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center h-full disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-brand-subtle ${showNoFlowAlert ? 'ring-4 ring-white scale-105' : ''}`}
        >
            <PlayIcon className="h-5 w-5 mr-2"/> Start Compressions
        </button>
        <div className="flex flex-col gap-2">
            <button onClick={() => dispatch({type: 'OPEN_MODAL', payload: {type: 'shock'}})} className="bg-brand-accent-yellow hover:opacity-90 transition-opacity text-brand-dark font-bold py-3 px-4 rounded-lg flex items-center justify-center"><BoltIcon className="h-5 w-5 mr-2"/> Shock Delivered</button>
            <button 
                onClick={() => log(EventType.SHOCK_DELIVERED, lastShockEnergy!)}
                disabled={!lastShockEnergy}
                className="bg-yellow-900/80 hover:bg-yellow-800/80 text-yellow-200 transition-all font-semibold py-2 px-4 rounded-lg flex items-center justify-center text-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-brand-subtle disabled:text-slate-400"
            >
                Repeat Shock {lastShockEnergy ? `(${lastShockEnergy})` : ''}
            </button>
        </div>
      </div>
      
      <h3 className="text-slate-300 mt-6 mb-2 text-md font-semibold">Common Medications</h3>
      <div className="space-y-3">
        <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Epinephrine', dose: '1mg IV Push', eventType: EventType.EPINEPHRINE_ADMINISTERED } } })} className="bg-brand-accent-blue hover:opacity-90 w-full transition-opacity text-white font-bold py-3 px-4 rounded-lg flex items-center justify-between"><div className="flex items-center"><SyringeIcon className="h-5 w-5 mr-3"/>Epinephrine</div> <span className="bg-blue-800 text-xs font-bold px-2 py-1 rounded">1mg</span></button>
        
        {/* Antiarrhythmics Group */}
        <div className="bg-brand-dark/30 p-2 rounded-lg border border-brand-subtle/50">
            <p className="text-xs text-slate-400 mb-2 uppercase tracking-wider font-semibold ml-1">Antiarrhythmics</p>
            <div className="grid grid-cols-2 gap-2">
                <button disabled={amioMaxReached} onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Amiodarone', dose: '300mg IV Push', eventType: EventType.AMIODARONE_ADMINISTERED } } })} className={`bg-brand-accent-purple hover:opacity-90 transition-opacity text-white font-bold py-2 px-3 rounded flex items-center justify-center text-sm ${amioMaxReached ? 'opacity-50 cursor-not-allowed' : ''}`}>Amio 300mg</button>
                <button disabled={amioMaxReached} onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Amiodarone', dose: '150mg IV Push', eventType: EventType.AMIODARONE_ADMINISTERED } } })} className={`bg-brand-accent-purple hover:opacity-90 transition-opacity text-white font-bold py-2 px-3 rounded flex items-center justify-center text-sm ${amioMaxReached ? 'opacity-50 cursor-not-allowed' : ''}`}>Amio 150mg</button>
                <button disabled={lidoMaxReached} onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Lidocaine', dose: '100mg IV Push', eventType: EventType.LIDOCAINE_ADMINISTERED } } })} className={`bg-brand-subtle hover:opacity-90 transition-opacity text-slate-200 font-bold py-2 px-3 rounded flex items-center justify-center text-sm ${lidoMaxReached ? 'opacity-50 cursor-not-allowed' : ''}`}>Lidocaine</button>
                 <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Magnesium Sulfate', dose: '2g IV/IO', eventType: EventType.OTHER_MEDICATION } } })} className="bg-brand-subtle hover:opacity-90 transition-opacity text-slate-200 font-bold py-2 px-3 rounded flex items-center justify-center text-sm">Magnesium</button>
            </div>
        </div>

        {/* Metabolic / Other Group */}
        <div className="bg-brand-dark/30 p-2 rounded-lg border border-brand-subtle/50">
             <p className="text-xs text-slate-400 mb-2 uppercase tracking-wider font-semibold ml-1">Metabolic & Other</p>
             <div className="grid grid-cols-3 gap-2">
                <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Calcium Chloride', dose: '1g IV/IO', eventType: EventType.OTHER_MEDICATION } } })} className="bg-brand-subtle hover:opacity-90 transition-opacity text-slate-200 font-bold py-2 px-2 rounded flex items-center justify-center text-xs">Calcium</button>
                <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Sodium Bicarbonate', dose: '50mEq IV/IO', eventType: EventType.OTHER_MEDICATION } } })} className="bg-brand-subtle hover:opacity-90 transition-opacity text-slate-200 font-bold py-2 px-2 rounded flex items-center justify-center text-xs">Bicarb</button>
                <button onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Atropine', dose: '1mg IV Push', eventType: EventType.OTHER_MEDICATION } } })} className="bg-brand-subtle hover:opacity-90 transition-opacity text-slate-200 font-bold py-2 px-2 rounded flex items-center justify-center text-xs">Atropine</button>
             </div>
        </div>

        <button onClick={() => dispatch({type: 'OPEN_MODAL', payload: {type: 'medication'}})} className="bg-brand-subtle hover:opacity-90 w-full transition-opacity text-slate-200 font-bold py-3 px-4 rounded-lg flex items-center justify-center mt-2"><PlusIcon className="h-5 w-5 mr-2"/> Other Medication</button>
      </div>
      
      <div className="mt-6 pt-4 border-t border-brand-subtle space-y-3">
        <button 
            onClick={() => dispatch({type: 'OPEN_MODAL', payload: {type: 'hs-and-ts'}})} 
            className="bg-brand-subtle hover:opacity-90 w-full transition-opacity text-slate-200 font-bold py-3 px-4 rounded-lg flex items-center justify-center"
        >
            <ListBulletIcon className="h-5 w-5 mr-2"/> H's & T's Checklist
        </button>
        <button 
            onClick={() => dispatch({type: 'OPEN_MODAL', payload: {type: 'note'}})} 
            className="bg-brand-subtle hover:opacity-90 w-full transition-opacity text-slate-200 font-bold py-3 px-4 rounded-lg flex items-center justify-center"
        >
            <PencilIcon className="h-5 w-5 mr-2"/> Add Nurse Note
        </button>
        <button onClick={() => dispatch({type: 'UNDO_LAST_ACTION'})} className="bg-brand-subtle hover:opacity-90 w-full transition-opacity text-slate-200 font-bold py-3 px-4 rounded-lg flex items-center justify-center"><ArrowUturnLeftIcon className="h-5 w-5 mr-2"/> Undo Last Action</button>
      </div>
    </Card>
  );
});

const EventLog = React.memo(({ events, startTime, dispatch, codeStatus }: { events: EventLogItem[], startTime: number | null, dispatch: React.Dispatch<Action>, codeStatus: CodeStatus }) => {
    const iconMap: { [key in EventType]?: React.ReactNode } = {
        [EventType.COMPRESSIONS_START]: <PlayIcon className="h-5 w-5 text-green-400"/>,
        [EventType.SHOCK_DELIVERED]: <BoltIcon className="h-5 w-5 text-yellow-400"/>,
        [EventType.EPINEPHRINE_ADMINISTERED]: <SyringeIcon className="h-5 w-5 text-blue-400"/>,
        [EventType.AMIODARONE_ADMINISTERED]: <SyringeIcon className="h-5 w-5 text-purple-400"/>,
        [EventType.LIDOCAINE_ADMINISTERED]: <SyringeIcon className="h-5 w-5 text-slate-400"/>,
        [EventType.OTHER_MEDICATION]: <SyringeIcon className="h-5 w-5 text-slate-400"/>,
        [EventType.NURSE_NOTE]: <PencilIcon className="h-5 w-5 text-slate-300"/>,
        [EventType.RHYTHM_CHECK_ROSC]: <CheckCircleIcon className="h-5 w-5 text-green-400"/>,
        [EventType.RHYTHM_CHECK_PULSELESS]: <XCircleIcon className="h-5 w-5 text-red-400"/>,
        [EventType.RHYTHM_ANALYZED]: <ChartBarIcon className="h-5 w-5 text-cyan-400"/>,
        [EventType.CHECKLIST_UPDATE]: <ListBulletIcon className="h-5 w-5 text-cyan-400"/>,
    };
    return (
    <Card title="Event Log" icon={<ClockIcon className="h-6 w-6"/>}>
        <div className="space-y-3 h-96 overflow-y-auto pr-2">
            {events.length === 0 && <p className="text-slate-400 text-center py-10">No events logged yet.</p>}
            {events.map(event => (
                <div key={event.id} className="relative flex items-start justify-between bg-brand-dark/50 p-3 rounded-lg group">
                    <div className="flex items-start">
                        <div className="flex-shrink-0 h-8 w-8 rounded-full bg-brand-subtle flex items-center justify-center mr-3">{iconMap[event.type]}</div>
                        <div>
                            <p className="font-semibold text-white">{event.type}</p>
                            <p className="text-sm text-slate-400 whitespace-pre-wrap">{event.details}</p>
                        </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                        <p className="font-mono text-slate-300">{formatTime(event.timestamp)}</p>
                        <p className="text-xs text-slate-500">{formatRelativeTime(event.timestamp, startTime)}</p>
                    </div>
                    {codeStatus !== 'inactive' && codeStatus !== 'history_view' && (
                        <button
                            onClick={() => {
                                if (window.confirm('Are you sure you want to delete this event?')) {
                                    dispatch({ type: 'DELETE_EVENT', payload: { id: event.id } })
                                }
                            }}
                            className="absolute top-1 right-1 text-slate-600 hover:text-red-500 transition-colors p-1 rounded-full opacity-0 group-hover:opacity-100 focus:opacity-100"
                            aria-label="Delete event"
                        >
                            <XMarkIcon className="h-4 w-4" />
                        </button>
                    )}
                </div>
            ))}
        </div>
    </Card>
    );
});

const SummaryCounts = React.memo(({ counts, lastShockEnergy }: { counts: AppState['summaryCounts'], lastShockEnergy: string | null }) => (
    <Card title="Summary Counts" icon={<ChartBarIcon className="h-6 w-6"/>}>
        <div className="grid grid-cols-4 gap-3 text-center">
            <div>
                <p className="text-4xl font-bold text-yellow-400">{counts.shocks}</p>
                <p className="text-slate-400 text-sm">Shocks</p>
                {lastShockEnergy && <p className="text-xs text-slate-500">Last: {lastShockEnergy}</p>}
            </div>
            <div>
                <p className="text-4xl font-bold text-blue-400">{counts.epinephrine}</p>
                <p className="text-slate-400 text-sm">Epinephrine</p>
            </div>
             <div>
                <p className="text-4xl font-bold text-purple-400">{counts.amiodarone}<span className="text-xs">mg</span></p>
                <p className="text-slate-400 text-sm">Amiodarone</p>
            </div>
            <div>
                <p className="text-4xl font-bold text-slate-400">{counts.lidocaine}<span className="text-xs">mg</span></p>
                <p className="text-slate-400 text-sm">Lidocaine</p>
            </div>
        </div>
        {Object.keys(counts.otherMedications).length > 0 && <div className="mt-4 pt-4 border-t border-brand-subtle">
             <h4 className="text-slate-300 mb-2 font-semibold">Other Medications:</h4>
             <ul className="text-slate-400 text-sm list-disc list-inside">
                 {Object.entries(counts.otherMedications).map(([name, count]) => (
                     <li key={name}>{name} &times; {count}</li>
                 ))}
             </ul>
        </div>}
    </Card>
));

const TimerDisplay: React.FC<{ 
    label: string, 
    time: number | null, 
    active: boolean, 
    activeColor?: string, 
    activeBgColor?: string
}> = ({ label, time, active, activeColor, activeBgColor }) => {
    const isCritical = active && time !== null && time <= 30;
    const topBarColor = active ? activeBgColor : 'bg-brand-subtle/50';
    const timeClassName = `text-4xl font-mono font-bold transition-colors ${
        active 
          ? (isCritical ? `${activeColor} animate-pulse` : activeColor || 'text-white')
          : 'text-slate-500'
    }`;
    
    return (
        <Card className="items-center justify-center text-center p-0 overflow-hidden">
             <div className={`h-2 w-full transition-colors ${topBarColor}`}></div>
             <div className="p-4 pt-2 flex flex-col items-center justify-center flex-grow w-full">
                <p className="text-slate-400 text-sm mb-1">{label}</p>
                <p className="text-4xl font-mono font-bold text-slate-200">
                    {time !== null ? formatTimeSecondary(time) : '--:--'}
                </p>
                {active && !isCritical && <div className="flex items-center text-green-400 text-xs mt-2"><div className="h-2 w-2 bg-green-400 rounded-full mr-1.5 animate-pulse"></div>Active</div>}
                {isCritical && <div className={`flex items-center ${activeColor} text-xs mt-2`}><div className={`h-2 w-2 ${activeBgColor} rounded-full mr-1.5 animate-ping`}></div>Critical</div>}
            </div>
        </Card>
    );
};

const GuidedActions = React.memo(({ state, dispatch }: { state: AppState, dispatch: React.Dispatch<Action> }) => {
    const { path, step } = state.algorithmState;
    const amioMaxReached = state.summaryCounts.amiodarone >= 450;
    const lidoMaxReached = state.summaryCounts.lidocaine >= 300;

    if (!path) {
        return (
            <Card className="items-center justify-center text-center bg-brand-subtle/20 border-2 border-dashed border-brand-subtle h-48">
                <p className="text-slate-400">Perform a Rhythm Check to begin guided workflow.</p>
            </Card>
        );
    }

    let action: { title: string, description: string, button: React.ReactNode } | null = null;
    
    const shockButton = <button onClick={() => dispatch({type: 'OPEN_MODAL', payload: {type: 'shock'}})} className="w-full bg-brand-accent-yellow text-brand-dark font-bold py-4 px-4 rounded-lg flex items-center justify-center text-2xl transition-transform hover:scale-105"><BoltIcon className="h-8 w-8 mr-3"/> Deliver Shock</button>;
    const epiButton = <button onClick={() => dispatch({ type: 'LOG_EVENT', payload: { type: EventType.EPINEPHRINE_ADMINISTERED, details: '1mg IV Push', actor: 'System', medicationName: 'Epinephrine' } })} className="w-full bg-brand-accent-blue text-white font-bold py-4 px-4 rounded-lg flex items-center justify-center text-2xl transition-transform hover:scale-105"><SyringeIcon className="h-8 w-8 mr-3"/> Administer Epinephrine</button>;
    const amioLidoButton = <div className="grid grid-cols-2 gap-3">
        <button disabled={amioMaxReached} onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Amiodarone', dose: '300mg IV Push', eventType: EventType.AMIODARONE_ADMINISTERED } } })} className={`bg-brand-accent-purple text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-xl transition-transform hover:scale-105 ${amioMaxReached ? 'opacity-50 cursor-not-allowed' : ''}`}><SyringeIcon className="h-6 w-6 mr-2"/>Amiodarone (300mg)</button>
        <button disabled={lidoMaxReached} onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Lidocaine', dose: '100mg IV Push', eventType: EventType.LIDOCAINE_ADMINISTERED } } })} className={`bg-slate-500 text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-xl transition-transform hover:scale-105 ${lidoMaxReached ? 'opacity-50 cursor-not-allowed' : ''}`}><SyringeIcon className="h-6 w-6 mr-2"/>Lidocaine</button>
    </div>;
    const secondAmioButton = <button disabled={amioMaxReached} onClick={() => dispatch({ type: 'OPEN_MODAL', payload: { type: 'medication', prefill: { name: 'Amiodarone', dose: '150mg IV Push', eventType: EventType.AMIODARONE_ADMINISTERED } } })} className={`w-full bg-brand-accent-purple text-white font-bold py-4 px-4 rounded-lg flex items-center justify-center text-2xl transition-transform hover:scale-105 ${amioMaxReached ? 'opacity-50 cursor-not-allowed' : ''}`}><SyringeIcon className="h-8 w-8 mr-3"/>Administer Amiodarone (150mg)</button>;
    const cprPrompt = <div className="text-center p-4 bg-brand-dark/50 rounded-lg"><p className="text-xl font-bold text-green-400">Resume High-Quality CPR</p><p className="text-slate-400">Restart 2-minute timer via 'Start Compressions' button.</p></div>

    if (path === 'shockable') {
        switch (step) {
            case 1: action = { title: "Shockable Rhythm: VF/pVT", description: "First action is to defibrillate.", button: shockButton }; break;
            case 2: action = { title: "Post-Shock", description: "Immediately resume compressions. Epinephrine is next.", button: cprPrompt }; break;
            case 3: action = { title: "Epinephrine Cycle", description: "Administer Epinephrine, then prepare for next rhythm check.", button: epiButton }; break;
            case 4: action = { title: "Post-Epinephrine", description: "Continue CPR. Another shock is due if rhythm persists.", button: cprPrompt }; break;
            case 5: action = { title: "Refractory VF/pVT", description: "Deliver another shock.", button: shockButton }; break;
            case 6: action = { title: "Antiarrhythmic Cycle", description: "Immediately resume CPR. Consider antiarrhythmic drugs.", button: cprPrompt }; break;
            case 7: action = { title: "Administer Antiarrhythmic", description: "Administer Amiodarone or Lidocaine.", button: amioLidoButton }; break;
            default: action = { title: "Continuing Cycles", description: "Continue CPR, administer Epinephrine every 3-5 mins.", button: epiButton };
        }
    } else { // non-shockable
        switch (step) {
            case 1: action = { title: "Non-Shockable: Asystole/PEA", description: "Administer Epinephrine as soon as possible.", button: epiButton }; break;
            case 2: action = { title: "Post-Epinephrine", description: "Immediately resume high-quality CPR.", button: cprPrompt }; break;
            default: action = { title: "Continuing Cycles", description: "Continue CPR, administer Epinephrine every 3-5 mins.", button: epiButton };
        }
    }

    return (
        <Card className="bg-brand-subtle/30 border-2 border-brand-accent-purple">
            <div className="flex items-center text-cyan-300 mb-4">
                <SparklesIcon className="h-6 w-6"/>
                <h2 className="text-lg font-semibold ml-2">Next Guided Action</h2>
            </div>
            <div className="text-center">
                <h3 className="text-2xl font-bold text-white">{action.title}</h3>
                <p className="text-slate-400 mb-6">{action.description}</p>
                {action.button}
            </div>
        </Card>
    );
});


const SuggestedActions = React.memo(({ state, dispatch }: { state: AppState, dispatch: React.Dispatch<Action> }) => {
    const handleFetchSuggestions = useCallback(async () => {
        dispatch({ type: 'FETCH_SUGGESTIONS_START' });

        const lastEvent = state.events[0] || { type: 'None', timestamp: 0 };
        const prompt = `You are an expert ACLS instructor providing guidance during a cardiac arrest. Based on the following summary, provide the top 3-4 most critical and likely next steps or considerations according to the latest AHA ACLS guidelines. Be very concise. Present the output as a simple list with each item starting with a hyphen (-). Do not add any introductory or concluding text.

Current Code State:
- Total Duration: ${formatTime(state.elapsedTime)}
- Time until next rhythm check: ${state.timers.rhythmCheck ? `${formatTimeSecondary(state.timers.rhythmCheck)} remaining` : 'Due now'}
- Time until next epinephrine dose: ${state.timers.epinephrine ? `${formatTimeSecondary(state.timers.epinephrine)} remaining` : 'Consider administering'}
- Total shocks delivered: ${state.summaryCounts.shocks}
- Last shock energy: ${state.lastShockEnergy || 'None'}
- Last event logged: ${lastEvent.type} at ${formatTime(lastEvent.timestamp)}
- Known medications given: Epinephrine x${state.summaryCounts.epinephrine}, Amiodarone ${state.summaryCounts.amiodarone}mg total
- H's and T's Considered: ${Object.entries(state.reversibleCauses).filter(([_, v]) => v).map(([k]) => k).join(', ') || 'None'}
`;

        try {
            const ai = new GoogleGenAI({apiKey: import.meta.env.VITE_GEMINI_API_KEY});
            const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });

            const response = await model.generateContent(prompt);
            const suggestions = response.response.text()
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('-'))
                .map(line => line.substring(1).trim());

            if (suggestions.length === 0) {
                dispatch({ type: 'FETCH_SUGGESTIONS_FAILURE', payload: 'Could not generate suggestions. Please try again.' });
            } else {
                dispatch({ type: 'FETCH_SUGGESTIONS_SUCCESS', payload: suggestions });
            }
        } catch (error) {
            console.error("Failed to fetch suggestions:", error);
            dispatch({ type: 'FETCH_SUGGESTIONS_FAILURE', payload: 'An error occurred while fetching suggestions.' });
        }
    }, [state, dispatch]);

    return (
        <Card title="ACLS Guideline Assist" icon={<SparklesIcon className="h-6 w-6 text-cyan-400"/>}>
            <div className="flex flex-col h-full">
                <div className="flex-grow min-h-[120px]">
                    {state.suggestions.isLoading ? (
                        <div className="flex items-center justify-center h-full text-slate-400">
                            <Cog6ToothIcon className="h-6 w-6 animate-spin mr-3"/>
                            Generating suggestions...
                        </div>
                    ) : state.suggestions.error ? (
                         <div className="flex flex-col items-center justify-center h-full text-red-400">
                            <XCircleIcon className="h-8 w-8 mb-2" />
                            <p>{state.suggestions.error}</p>
                        </div>
                    ) : state.suggestions.data.length > 0 ? (
                        <ul className="space-y-3">
                            {state.suggestions.data.map((suggestion, index) => (
                                <li key={index} className="flex items-start bg-brand-dark/50 p-3 rounded-md">
                                    <CheckCircleIcon className="h-5 w-5 text-cyan-400 mr-3 mt-0.5 flex-shrink-0"/>
                                    <span className="text-slate-300">{suggestion}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-center text-slate-400 py-4">
                            <p>Click the button below to get real-time suggestions based on the latest ACLS guidelines.</p>
                        </div>
                    )}
                </div>
                <button
                    onClick={handleFetchSuggestions}
                    disabled={state.suggestions.isLoading}
                    className="mt-4 w-full bg-cyan-600 hover:bg-cyan-500 disabled:bg-brand-subtle disabled:cursor-wait text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center transition-colors"
                >
                    <SparklesIcon className="h-5 w-5 mr-2"/>
                    {state.suggestions.isLoading ? 'Thinking...' : 'Get Suggestions'}
                </button>
            </div>
        </Card>
    );
});


const TimerSettings = React.memo(({ settings, dispatch }: { settings: AppState['timerSettings'], dispatch: React.Dispatch<Action> }) => {
  const handleSettingChange = (timer: 'rhythmCheck' | 'epinephrine', value: string) => {
    const minutes = parseInt(value, 10);
    if (!isNaN(minutes) && minutes > 0 && minutes < 60) { // Limit to reasonable values
      dispatch({ type: 'UPDATE_TIMER_SETTING', payload: { timer, value: minutes * 60 } });
    }
  };

  return (
    <Card title="Timer Intervals" icon={<ClockIcon className="h-6 w-6"/>}>
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <label htmlFor="rhythm-interval" className="font-medium text-slate-300">Rhythm Check Interval</label>
                <div className="flex items-center">
                    <input
                        id="rhythm-interval"
                        type="number"
                        value={settings.rhythmCheck / 60}
                        onChange={(e) => handleSettingChange('rhythmCheck', e.target.value)}
                        className="w-20 bg-brand-dark border border-brand-subtle rounded-md p-2 text-white text-center font-mono focus:ring-brand-accent-yellow focus:border-brand-accent-yellow"
                        min="1"
                        max="10"
                    />
                    <span className="ml-2 text-slate-400">min</span>
                </div>
            </div>
            <div className="flex items-center justify-between">
                <label htmlFor="epi-interval" className="font-medium text-slate-300">Epinephrine Interval</label>
                <div className="flex items-center">
                    <input
                        id="epi-interval"
                        type="number"
                        value={settings.epinephrine / 60}
                        onChange={(e) => handleSettingChange('epinephrine', e.target.value)}
                        className="w-20 bg-brand-dark border border-brand-subtle rounded-md p-2 text-white text-center font-mono focus:ring-brand-accent-blue focus:border-brand-accent-blue"
                        min="1"
                        max="10"
                    />
                    <span className="ml-2 text-slate-400">min</span>
                </div>
            </div>
        </div>
    </Card>
  );
});

const GlobalSettingsModal: React.FC<{ isOpen: boolean, onClose: () => void, dispatch: React.Dispatch<Action> }> = ({ isOpen, onClose, dispatch }) => {
    const [activeTab, setActiveTab] = useState<'general' | 'history' | 'users'>('history');
    const [history, setHistory] = useState<SavedCodeRecord[]>([]);

    // Authentication
    const [loginUser, setLoginUser] = useState('');
    const [loginPass, setLoginPass] = useState('');
    const [authError, setAuthError] = useState('');
    const [currentUser, setCurrentUser] = useState<{username:string, role:string} | null>(null);

    // Users (persisted in localStorage)
    const USERS_KEY = 'CPR_USERS';
    const [users, setUsers] = useState<{id:number, username:string, role:string, password?:string}[]>(() => {
        try {
            const raw = localStorage.getItem(USERS_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        return [{ id: 1, username: 'admin', role: 'Admin', password: '12345678' }];
    });
    const [newUsername, setNewUsername] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<'Admin'|'User'>('User');

    useEffect(() => {
        if (isOpen && activeTab === 'history') {
            try {
                const data = localStorage.getItem(CPR_HISTORY_KEY);
                if (data) {
                    setHistory(JSON.parse(data).reverse()); // Show newest first
                } else {
                    setHistory([]);
                }
            } catch (e) {
                console.error("Failed to load history", e);
            }
        }
    }, [isOpen, activeTab]);

    useEffect(() => {
        try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch (e) { console.error(e); }
    }, [users]);

    const handleViewRecord = (record: SavedCodeRecord) => {
        dispatch({ type: 'VIEW_HISTORY_RECORD', payload: record });
        onClose();
    };

    const handleLogin = (e?: React.FormEvent) => {
        e?.preventDefault();
        setAuthError('');
        const found = users.find(u => u.username === loginUser && u.password === loginPass);
        if (found) {
            setCurrentUser({ username: found.username, role: found.role });
            setLoginUser(''); setLoginPass('');
            setAuthError('');
        } else {
            setAuthError('Invalid credentials');
        }
    };

    const handleLogout = () => {
        setCurrentUser(null);
        setAuthError('');
    };

    const handleAddUser = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newUsername) return;
        const next = { id: users.length ? Math.max(...users.map(u=>u.id)) + 1 : 1, username: newUsername, role: newRole, password: newPassword };
        setUsers(prev => [...prev, next]);
        setNewUsername(''); setNewPassword(''); setNewRole('User');
    };

    const handleDeleteUser = (id: number) => {
        // Prevent deleting admin user
        const u = users.find(x=>x.id===id);
        if (u?.username === 'admin') return;
        setUsers(prev => prev.filter(x => x.id !== id));
        // If deleting currently logged-in user, log them out
        if (currentUser?.username === u?.username) setCurrentUser(null);
    };

    const handleUpdateUserRole = (id:number, role:'Admin'|'User') => {
        setUsers(prev => prev.map(u => u.id===id ? {...u, role} : u));
        // If updating current user role, reflect it
        if (currentUser?.username && users.find(u=>u.id===id)?.username === currentUser.username) {
            setCurrentUser({ username: currentUser.username, role });
        }
    };

    const handleDeleteRecord = (id: string) => {
        if (currentUser?.role !== 'Admin') return;
        try {
            const raw = localStorage.getItem(CPR_HISTORY_KEY);
            if (!raw) return;
            const arr: SavedCodeRecord[] = JSON.parse(raw);
            const filtered = arr.filter(r => r.id !== id);
            localStorage.setItem(CPR_HISTORY_KEY, JSON.stringify(filtered));
            setHistory(filtered.reverse());
        } catch (e) { console.error(e); }
    };

    // General settings stored in localStorage
    const APP_SETTINGS_KEY = 'CPR_APP_SETTINGS';
    const [appSettings, setAppSettings] = useState<{rhythmCheck:number, epinephrine:number}>(() => {
        try {
            const raw = localStorage.getItem(APP_SETTINGS_KEY);
            if (raw) return JSON.parse(raw);
        } catch {}
        return { rhythmCheck: 120, epinephrine: 180 };
    });

    const handleSaveAppSettings = (e?:React.FormEvent) => {
        e?.preventDefault();
        try { localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings)); } catch (e) { console.error(e); }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-brand-card rounded-lg shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col border border-brand-subtle" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-brand-subtle">
                    <h2 className="text-xl font-bold flex items-center">
                        <Cog6ToothIcon className="h-6 w-6 mr-2 text-slate-400" />
                        Settings & Admin
                    </h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-white">
                        <XMarkIcon className="h-6 w-6" />
                    </button>
                </div>

                <div className="flex border-b border-brand-subtle">
                    <button 
                        onClick={() => setActiveTab('history')}
                        className={`px-6 py-3 font-semibold transition-colors ${activeTab === 'history' ? 'border-b-2 border-brand-accent-blue text-brand-accent-blue' : 'text-slate-400 hover:text-white'}`}
                    >
                        Code History
                    </button>
                    <button 
                        onClick={() => setActiveTab('general')}
                        className={`px-6 py-3 font-semibold transition-colors ${activeTab === 'general' ? 'border-b-2 border-brand-accent-blue text-brand-accent-blue' : 'text-slate-400 hover:text-white'}`}
                    >
                        General
                    </button>
                    <button 
                        onClick={() => setActiveTab('users')}
                        className={`px-6 py-3 font-semibold transition-colors ${activeTab === 'users' ? 'border-b-2 border-brand-accent-blue text-brand-accent-blue' : 'text-slate-400 hover:text-white'}`}
                    >
                        User Management
                    </button>
                </div>

                <div className="flex-grow overflow-y-auto p-6">
                    {/* Login / current user status */}
                    <div className="flex items-center justify-end mb-4">
                        {!currentUser ? (
                            <form onSubmit={handleLogin} className="flex items-center gap-3">
                                <input className="bg-brand-dark border border-brand-subtle rounded px-2 py-1 text-white text-sm" placeholder="username" value={loginUser} onChange={e=>setLoginUser(e.target.value)} />
                                <input type="password" className="bg-brand-dark border border-brand-subtle rounded px-2 py-1 text-white text-sm" placeholder="password" value={loginPass} onChange={e=>setLoginPass(e.target.value)} />
                                <button className="bg-brand-accent-blue text-white px-3 py-1 rounded text-sm">Login</button>
                            </form>
                        ) : (
                            <div className="flex items-center gap-3">
                                <span className="text-sm text-green-400">{currentUser.username} ({currentUser.role})</span>
                                <button onClick={handleLogout} className="text-slate-400 hover:text-white text-sm">Logout</button>
                            </div>
                        )}
                    </div>
                    {authError && <div className="text-red-400 text-sm mb-4">{authError}</div>}

                    {activeTab === 'history' && (
                        <div>
                            {!currentUser ? (
                                <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                                    <LockClosedIcon className="h-12 w-12 mb-4" />
                                    <p className="text-lg">Sign in to view Code History.</p>
                                    <p className="text-sm mt-2 text-slate-500">Use an account created in User Management. Admin (admin/12345678) can manage records.</p>
                                </div>
                            ) : (
                                <>
                                    {history.length === 0 ? (
                                        <div className="text-center text-slate-500 py-10">No recorded codes found.</div>
                                    ) : (
                                        <div className="space-y-3">
                                            {history.map(record => (
                                                <div key={record.id} className="bg-brand-dark/50 p-4 rounded-lg flex items-center justify-between hover:bg-brand-dark/70 transition-colors">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-mono text-brand-accent-blue">{new Date(record.date).toLocaleDateString()}</span>
                                                            <span className="text-slate-500 text-sm">{new Date(record.date).toLocaleTimeString()}</span>
                                                        </div>
                                                        <div className="text-lg font-semibold mt-1">
                                                            {record.patientDetails.hn ? `HN: ${record.patientDetails.hn}` : 'Unknown Patient'}
                                                            <span className="text-slate-400 font-normal ml-2">({formatTime(record.elapsedTime)})</span>
                                                        </div>
                                                        <div className="text-sm text-slate-400 mt-1">
                                                            Outcome: <span className={record.outcome === 'ROSC' ? 'text-green-400' : 'text-slate-300'}>{record.outcome}</span>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <button 
                                                            onClick={() => handleViewRecord(record)}
                                                            className="bg-brand-subtle hover:bg-brand-accent-blue text-white px-4 py-2 rounded flex items-center transition-colors"
                                                        >
                                                            <EyeIcon className="h-5 w-5 mr-2" />
                                                            Review
                                                        </button>
                                                        {currentUser.role === 'Admin' && (
                                                            <button onClick={() => handleDeleteRecord(record.id)} className="text-red-400 hover:underline text-sm">Delete</button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {activeTab === 'general' && (
                        <div className="py-6">
                            <form onSubmit={handleSaveAppSettings} className="max-w-md mx-auto space-y-4 text-left">
                                <div>
                                    <label className="block text-slate-400 text-sm mb-1">Rhythm Check (seconds)</label>
                                    <input type="number" value={appSettings.rhythmCheck} onChange={e=>setAppSettings({...appSettings, rhythmCheck: Number(e.target.value)})} className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white" />
                                </div>
                                <div>
                                    <label className="block text-slate-400 text-sm mb-1">Epinephrine Interval (seconds)</label>
                                    <input type="number" value={appSettings.epinephrine} onChange={e=>setAppSettings({...appSettings, epinephrine: Number(e.target.value)})} className="w-full bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white" />
                                </div>
                                <div className="flex justify-end">
                                    {currentUser?.role === 'Admin' ? (
                                        <button className="bg-brand-accent-blue text-white px-4 py-2 rounded">Save Settings</button>
                                    ) : (
                                        <div className="text-slate-400 text-sm">Admin only: sign in to edit settings.</div>
                                    )}
                                </div>
                            </form>
                        </div>
                    )}

                    {activeTab === 'users' && (
                        <div>
                            {currentUser?.role !== 'Admin' ? (
                                <div className="text-center text-slate-400 py-10">Admin access required to manage users.</div>
                            ) : (
                                <div>
                                    <form onSubmit={handleAddUser} className="flex gap-3 mb-4">
                                        <input value={newUsername} onChange={e=>setNewUsername(e.target.value)} placeholder="username" className="flex-grow bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white" />
                                        <input value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="password" type="password" className="bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white w-56" />
                                        <select value={newRole} onChange={e=>setNewRole(e.target.value as 'Admin'|'User') } className="bg-brand-dark border border-brand-subtle rounded px-3 py-2 text-white">
                                            <option value="User">User</option>
                                            <option value="Admin">Admin</option>
                                        </select>
                                        <button className="bg-brand-accent-blue text-white px-4 py-2 rounded">Add User</button>
                                    </form>
                                    <div className="bg-brand-dark rounded-lg p-4">
                                        <table className="w-full text-left">
                                            <thead>
                                                <tr className="border-b border-brand-subtle text-slate-400 text-sm">
                                                    <th className="p-2">ID</th>
                                                    <th className="p-2">Username</th>
                                                    <th className="p-2">Role</th>
                                                    <th className="p-2">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {users.map(u => (
                                                    <tr key={u.id} className="border-b border-brand-dark/50">
                                                        <td className="p-2">{u.id}</td>
                                                        <td className="p-2">{u.username}</td>
                                                        <td className="p-2">
                                                            {currentUser?.role === 'Admin' ? (
                                                                <select value={u.role} onChange={e=>handleUpdateUserRole(u.id, e.target.value as 'Admin'|'User')} className="bg-brand-dark border border-brand-subtle rounded px-2 py-1 text-white text-sm">
                                                                    <option value="User">User</option>
                                                                    <option value="Admin">Admin</option>
                                                                </select>
                                                            ) : u.role}
                                                        </td>
                                                        <td className="p-2">
                                                            <div className="flex items-center gap-3">
                                                                <button onClick={() => handleDeleteUser(u.id)} className="text-red-400 hover:underline text-sm" disabled={u.username === 'admin'}>Delete</button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const Modal: React.FC<{
    modalState: ModalState,
    dispatch: React.Dispatch<Action>,
    reversibleCauses: HsandTs,
    algorithmState: AppState['algorithmState'],
    lastShockEnergy: string | null
}> = ({ modalState, dispatch, reversibleCauses, algorithmState, lastShockEnergy }) => {
    const [shockEnergy, setShockEnergy] = useState('200');
    const [medicationName, setMedicationName] = useState('');
    const [medicationDose, setMedicationDose] = useState('');
    const [nurseNote, setNurseNote] = useState('');
    
    const commonDrugs = [
        "Adenosine", "Aspirin", "Atropine", "Calcium Chloride", "Calcium Gluconate", 
        "Dextrose 50%", "Diphenhydramine", "Fentanyl", "Glucagon", "Heparin",
        "Insulin", "Ketamine", "Magnesium Sulfate", "Midazolam", "Morphine", 
        "Naloxone", "Nitroglycerin", "Norepinephrine", "Ondansetron",
        "Propofol", "Rocuronium", "Sodium Bicarbonate", "Succinylcholine", "Vasopressin"
    ];
    
    // State for the new "Record -> Stop -> Transcribe" workflow
    type RecordingStatus = 'idle' | 'recording' | 'recorded' | 'transcribing' | 'error';
    const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
    const [recordingError, setRecordingError] = useState<string | null>(null);
    const [audioBlob, setAudioBlob] = useState<globalThis.Blob | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioStreamRef = useRef<MediaStream | null>(null);
    const audioChunksRef = useRef<globalThis.Blob[]>([]);

    const cleanupRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        audioStreamRef.current?.getTracks().forEach(track => track.stop());
        mediaRecorderRef.current = null;
        audioStreamRef.current = null;
        audioChunksRef.current = [];
        setAudioBlob(null);
    }, []);

    const handleStartRecording = async () => {
        setRecordingStatus('idle');
        setRecordingError(null);
        if (mediaRecorderRef.current) {
            cleanupRecording();
        }

        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error("Your browser does not support audio recording.");
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioStreamRef.current = stream;
            
            const recorder = new MediaRecorder(stream);
            mediaRecorderRef.current = recorder;
            audioChunksRef.current = [];

            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            recorder.onstop = () => {
                const blob = new globalThis.Blob(audioChunksRef.current, { type: 'audio/webm' });
                setAudioBlob(blob);
                setRecordingStatus('recorded');
                // Clean up the stream tracks as we are done with them
                audioStreamRef.current?.getTracks().forEach(track => track.stop());
                audioStreamRef.current = null;
            };
            
            recorder.onerror = (event) => {
                console.error("MediaRecorder error:", event);
                setRecordingError('An error occurred during recording.');
                setRecordingStatus('error');
                cleanupRecording();
            };

            recorder.start();
            setRecordingStatus('recording');

        } catch (error) {
            console.error("Failed to start recording:", error);
            if (error instanceof Error) {
                 if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                    setRecordingError('Microphone permission denied.');
                 } else {
                    setRecordingError(error.message);
                 }
            } else {
                setRecordingError('An unknown error occurred.');
            }
            setRecordingStatus('error');
        }
    };
    
    const handleStopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
            // onstop handler will set the status to 'recorded'
        }
    };
    
    const handleDiscardRecording = () => {
        cleanupRecording();
        setRecordingStatus('idle');
        setRecordingError(null);
    };

    const handleTranscribe = async () => {
        if (!audioBlob) {
            setRecordingError("No audio available to transcribe.");
            setRecordingStatus('error');
            return;
        }
        setRecordingStatus('transcribing');
        setRecordingError(null);

        try {
            const ai = new GoogleGenAI({apiKey: import.meta.env.VITE_GEMINI_API_KEY});
            const model = ai.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
            const audioData = await blobToBase64(audioBlob);
            
            const prompt = "Transcribe the following audio precisely. The audio is a nurse's note during a medical emergency.";
            const audioPart = {
              inlineData: {
                data: audioData,
                mimeType: audioBlob.type,
              },
            };

            const response = await model.generateContent([prompt, audioPart]);
            
            const transcription = response.response.text();
            setNurseNote(prevNote => (prevNote ? prevNote + ' ' : '') + transcription);
            setRecordingStatus('idle');
            setAudioBlob(null);

        } catch (error) {
            console.error("Transcription failed:", error);
            setRecordingError("Failed to transcribe audio. Please try again.");
            setRecordingStatus('error');
        }
    };

    useEffect(() => {
        if (modalState.isOpen && modalState.type === 'shock') {
            // Smart Step Up Logic
            const ENERGY_LEVELS = [120, 150, 200, 300, 360];
            if (lastShockEnergy) {
                const lastVal = parseDose(lastShockEnergy);
                const nextLevel = ENERGY_LEVELS.find(l => l > lastVal);
                setShockEnergy(nextLevel ? nextLevel.toString() : lastVal.toString());
            } else {
                setShockEnergy('200'); // Default first shock
            }
        }
        if (modalState.isOpen && modalState.type === 'medication') {
            if (modalState.prefill) {
                setMedicationName(modalState.prefill.name);
                setMedicationDose(modalState.prefill.dose);
            } else {
                setMedicationName('');
                setMedicationDose('');
            }
        }
        if (modalState.isOpen && modalState.type === 'note') {
            setNurseNote('');
            handleDiscardRecording(); // Reset state when opening
        }

        // Cleanup on modal close
        return () => {
            if (modalState.isOpen) {
               cleanupRecording();
            }
        };
    }, [modalState.isOpen, modalState.type, modalState.prefill, lastShockEnergy]);

    const handleClose = () => {
        cleanupRecording();
        setRecordingStatus('idle');
        dispatch({ type: 'CLOSE_MODAL' });
    };

    const handleShockSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        dispatch({ type: 'LOG_EVENT', payload: { type: EventType.SHOCK_DELIVERED, details: `${shockEnergy}J Biphasic`, actor: 'By: Nurse Casey' } });
        handleClose();
    };

    const handleMedicationSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!medicationName.trim() || !medicationDose.trim()) return;

        const eventType = modalState.prefill?.eventType || EventType.OTHER_MEDICATION;
        const medicationNameToLog = modalState.prefill?.name || medicationName;
        
        const details = eventType === EventType.OTHER_MEDICATION || eventType === EventType.LIDOCAINE_ADMINISTERED || !modalState.prefill
            ? `${medicationNameToLog} ${medicationDose}` 
            : medicationDose;
        
        dispatch({ type: 'LOG_EVENT', payload: { type: eventType, details: details, actor: 'By: Nurse Casey', medicationName: medicationNameToLog } });
        handleClose();
    };

    const handleNoteSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!nurseNote.trim()) return;
        dispatch({ type: 'LOG_EVENT', payload: { type: EventType.NURSE_NOTE, details: nurseNote, actor: 'By: Nurse Casey' } });
        handleClose();
    };

    if (!modalState.isOpen) return null;
    
    const renderNoteScribeControls = () => {
        switch (recordingStatus) {
            case 'idle':
                return (
                    <button type="button" onClick={handleStartRecording} className="bg-brand-subtle hover:bg-slate-500 text-slate-200 font-semibold py-2 px-4 rounded-lg flex items-center justify-center transition-colors">
                        <MicrophoneIcon className="h-5 w-5 mr-2" />
                        Record Note
                    </button>
                );
            case 'recording':
                return (
                    <button type="button" onClick={handleStopRecording} className="bg-brand-accent-red hover:bg-red-500 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center transition-colors animate-pulse">
                        <StopCircleIcon className="h-5 w-5 mr-2" />
                        Stop Recording
                    </button>
                );
            case 'recorded':
                return (
                    <div className="flex items-center gap-2">
                        <button type="button" onClick={handleTranscribe} className="flex-1 bg-brand-accent-green hover:bg-green-500 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center transition-colors">
                            <SparklesIcon className="h-5 w-5 mr-2" />
                            Transcribe
                        </button>
                        <button type="button" onClick={handleDiscardRecording} className="bg-brand-subtle hover:bg-slate-500 text-slate-200 font-semibold py-2 px-4 rounded-lg transition-colors">
                            Discard
                        </button>
                    </div>
                );
            case 'transcribing':
                return (
                    <div className="text-slate-400 flex items-center justify-center p-2">
                         <Cog6ToothIcon className="h-5 w-5 mr-2 animate-spin" /> Transcribing...
                    </div>
                );
            case 'error':
                 return (
                    <button type="button" onClick={handleDiscardRecording} className="bg-brand-subtle hover:bg-slate-500 text-slate-200 font-semibold py-2 px-4 rounded-lg flex items-center justify-center transition-colors">
                        <ArrowUturnLeftIcon className="h-5 w-5 mr-2" />
                        Try Again
                    </button>
                );
        }
    };

    const HTChecklist = () => {
        const formatLabel = (key: string) => {
            // Convert camelCase to Title Case for display
            return key.replace(/([A-Z])/g, ' $1').replace(/^./, function(str){ return str.toUpperCase(); });
        };

        return (
            <div className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
                <p className="text-slate-300 mb-4 text-center">Review and treat potential reversible causes.</p>
                <div className="grid grid-cols-1 gap-3">
                    {Object.entries(reversibleCauses).map(([key, value]) => (
                        <button 
                            key={key} 
                            onClick={() => {
                                dispatch({ type: 'TOGGLE_H_T', payload: { cause: key as keyof HsandTs } });
                                dispatch({ type: 'LOG_EVENT', payload: { type: EventType.CHECKLIST_UPDATE, details: `${formatLabel(key)}: ${!value ? 'Considered/Treated' : 'Cleared'}`, actor: 'System' }})
                            }}
                            className={`flex items-center justify-between p-3 rounded-lg border transition-all ${value ? 'bg-brand-accent-green/20 border-brand-accent-green text-white' : 'bg-brand-dark border-brand-subtle text-slate-400 hover:border-slate-400'}`}
                        >
                            <span className="font-semibold">{formatLabel(key)}</span>
                            {value ? <CheckCircleIcon className="h-6 w-6 text-brand-accent-green" /> : <span className="h-6 w-6 block rounded-full border-2 border-slate-600"></span>}
                        </button>
                    ))}
                </div>
                <button onClick={handleClose} className="w-full mt-4 bg-brand-subtle hover:bg-slate-600 text-white font-bold py-3 px-4 rounded-lg">Done</button>
            </div>
        );
    };

    // CDSS Recommendation Modal
    if (modalState.type === 'cdss-recommendation') {
        const isShockable = algorithmState.path === 'shockable';
        const title = isShockable ? "RECOMMENDATION: DEFIBRILLATE" : "RECOMMENDATION: EPINEPHRINE";
        const borderColor = isShockable ? 'border-brand-accent-yellow' : 'border-brand-accent-red';
        
        return (
             <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={handleClose}>
                <div className={`bg-brand-card rounded-lg shadow-2xl w-full max-w-md border-t-8 ${borderColor} flex flex-col items-center text-center p-0 overflow-hidden animate-fade-in`} onClick={e => e.stopPropagation()}>
                    <div className="p-8 w-full">
                        <div className="flex justify-center mb-4">
                            {isShockable ? (
                                <BoltIcon className="h-16 w-16 text-yellow-400 animate-pulse" />
                            ) : (
                                <SyringeIcon className="h-16 w-16 text-red-400 animate-bounce" />
                            )}
                        </div>
                        <h2 className="text-2xl font-extrabold uppercase mb-2 text-white">{title}</h2>
                        <p className="text-slate-300 mb-6">
                            {isShockable 
                                ? "Guideline: For VF/pVT, immediate defibrillation is the priority intervention." 
                                : "Guideline: For Asystole/PEA, administer Epinephrine (1mg) as soon as possible."}
                        </p>

                        {isShockable ? (
                            <div className="space-y-3">
                                <button 
                                    onClick={() => {
                                        dispatch({ type: 'LOG_EVENT', payload: { type: EventType.SHOCK_DELIVERED, details: '200J Biphasic', actor: 'System' } });
                                        handleClose();
                                    }} 
                                    className="w-full bg-brand-accent-yellow hover:bg-yellow-400 text-black font-bold py-4 px-6 rounded-lg text-xl flex items-center justify-center shadow-lg"
                                >
                                    <BoltIcon className="h-6 w-6 mr-2"/>
                                    Log Shock Delivered
                                </button>
                                <button onClick={handleClose} className="w-full bg-brand-subtle hover:bg-slate-600 text-white font-bold py-3 px-6 rounded-lg">
                                    Dismiss (Log Rhythm Only)
                                </button>
                            </div>
                        ) : (
                             <div className="space-y-3">
                                <div className="bg-red-500/20 border border-red-500/50 p-3 rounded mb-2">
                                    <p className="text-red-200 text-sm">Reminder: Administer 1mg Epinephrine via dashboard</p>
                                </div>
                                <button onClick={handleClose} className="w-full bg-brand-accent-green hover:bg-green-500 text-white font-bold py-4 px-6 rounded-lg text-xl flex items-center justify-center shadow-lg">
                                    <CheckCircleIcon className="h-6 w-6 mr-2"/>
                                    Acknowledge & Resume CPR
                                </button>
                            </div>
                        )}
                    </div>
                </div>
             </div>
        );
    }


    return (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
            <div className="bg-brand-card rounded-lg shadow-xl w-full max-w-md animate-fade-in" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-brand-subtle">
                    <h3 className="text-xl font-bold">{
                        modalState.type === 'shock' ? 'Log Shock' :
                        modalState.type === 'medication' ? (modalState.prefill ? `Log ${modalState.prefill.name}` : 'Log Other Medication') :
                        modalState.type === 'note' ? 'Add Nurse Note' :
                        modalState.type === 'hs-and-ts' ? 'Reversible Causes (H\'s & T\'s)' :
                        modalState.type === 'initial-rhythm' ? 'Select Initial Rhythm' :
                        'Classify Rhythm'
                    }</h3>
                    {modalState.type !== 'initial-rhythm' && <button onClick={handleClose} className="text-slate-400 hover:text-white"><XMarkIcon className="h-6 w-6"/></button>}
                </div>
                {modalState.type === 'hs-and-ts' && <HTChecklist />}
                {(modalState.type === 'rhythm-classification' || modalState.type === 'initial-rhythm') && (
                     <div className="p-6 space-y-4">
                        <p className="text-center text-slate-300 mb-4">
                            {modalState.type === 'initial-rhythm' 
                                ? "Please select the initial waveform pattern to begin the guided ACLS workflow."
                                : "The patient is pulseless. Please classify the observed rhythm to continue."}
                        </p>
                        <button onClick={() => dispatch({type: 'SET_ALGORITHM_PATH', payload: { path: 'shockable' }})} className="w-full bg-brand-accent-yellow text-brand-dark font-bold py-4 px-4 rounded-lg flex items-center justify-center text-xl transition-transform hover:scale-105"><BoltIcon className="h-6 w-6 mr-3"/> VF / Pulseless VT (Shockable)</button>
                        <button onClick={() => dispatch({type: 'SET_ALGORITHM_PATH', payload: { path: 'non-shockable' }})} className="w-full bg-brand-accent-red text-white font-bold py-4 px-4 rounded-lg flex items-center justify-center text-xl transition-transform hover:scale-105"><XCircleIcon className="h-6 w-6 mr-3"/> Asystole / PEA (Non-Shockable)</button>
                    </div>
                )}
                {modalState.type === 'shock' && (
                    <form onSubmit={handleShockSubmit} className="p-6 space-y-6">
                        <div className="grid grid-cols-3 gap-3">
                            {[120, 150, 200, 300, 360].map(joules => (
                                <button
                                    key={joules}
                                    type="button"
                                    onClick={() => setShockEnergy(joules.toString())}
                                    className={`py-4 rounded-lg font-bold text-lg transition-all border-2 ${
                                        shockEnergy === joules.toString()
                                            ? 'bg-brand-accent-yellow text-black border-brand-accent-yellow scale-105 shadow-lg'
                                            : 'bg-brand-dark text-slate-400 border-brand-subtle hover:border-yellow-600 hover:text-yellow-100'
                                    }`}
                                >
                                    {joules}J
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center justify-between text-sm text-slate-400 px-2">
                            <span>Last: {lastShockEnergy || 'None'}</span>
                            <span>Selected: <strong className="text-yellow-400 text-lg">{shockEnergy}J</strong></span>
                        </div>
                        <button type="submit" className="w-full bg-brand-accent-yellow text-brand-dark font-bold py-4 px-4 rounded-lg hover:opacity-90 transition-transform hover:scale-105 shadow-lg flex items-center justify-center text-xl">
                            <BoltIcon className="h-6 w-6 mr-2"/> Log Shock
                        </button>
                    </form>
                )}
                {modalState.type === 'medication' && (
                    <form onSubmit={handleMedicationSubmit} className="p-6 space-y-4">
                        <div>
                            <label htmlFor="med-name" className="block text-sm font-medium text-slate-300">Medication Name</label>
                            <input
                                id="med-name"
                                type="text"
                                list="medication-suggestions"
                                value={medicationName}
                                onChange={(e) => setMedicationName(e.target.value)}
                                className="w-full mt-1 bg-brand-dark border border-brand-subtle rounded-md p-2 text-white placeholder-slate-500 focus:ring-brand-accent-blue focus:border-brand-accent-blue disabled:bg-brand-subtle/50 disabled:cursor-not-allowed"
                                placeholder="e.g., Adenosine"
                                autoFocus={!modalState.prefill}
                                disabled={!!modalState.prefill?.name}
                                autoComplete="off"
                            />
                            <datalist id="medication-suggestions">
                                {commonDrugs.map(drug => (
                                    <option key={drug} value={drug} />
                                ))}
                            </datalist>
                        </div>
                        <div>
                            <label htmlFor="med-dose" className="block text-sm font-medium text-slate-300">Dose & Route</label>
                            <input
                                id="med-dose"
                                type="text"
                                value={medicationDose}
                                onChange={(e) => setMedicationDose(e.target.value)}
                                className="w-full mt-1 bg-brand-dark border border-brand-subtle rounded-md p-2 text-white placeholder-slate-500 focus:ring-brand-accent-blue focus:border-brand-accent-blue"
                                placeholder="e.g., 100mg IV Push"
                                autoFocus={!!modalState.prefill}
                            />
                        </div>
                        <button type="submit" className="w-full bg-brand-accent-blue text-white font-bold py-2 px-4 rounded-lg hover:opacity-90 transition-opacity">Log Medication</button>
                    </form>
                )}
                {modalState.type === 'note' && (
                    <form onSubmit={handleNoteSubmit} className="p-6 space-y-4">
                        <div>
                            <label htmlFor="nurse-note" className="block text-sm font-medium text-slate-300">Note Content</label>
                            <textarea
                                id="nurse-note"
                                value={nurseNote}
                                onChange={(e) => setNurseNote(e.target.value)}
                                className="w-full mt-1 bg-brand-dark border border-brand-subtle rounded-md p-2 text-white placeholder-slate-500 focus:ring-brand-accent-blue focus:border-brand-accent-blue"
                                placeholder="Record a voice note or type directly..."
                                rows={5}
                                autoFocus
                            />
                            {recordingError && <p className="text-red-400 text-sm mt-2">{recordingError}</p>}
                        </div>
                        <div className="flex flex-col gap-2">
                            {renderNoteScribeControls()}
                            <button type="submit" className="w-full bg-brand-accent-blue text-white font-bold py-2 px-4 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50" disabled={recordingStatus !== 'idle' && recordingStatus !== 'recorded'}>Log Note</button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
};

const AlertModal: React.FC<{ state: AppState, dispatch: React.Dispatch<Action> }> = ({ state, dispatch }) => {
    const { showRhythmAlert, epinephrineDue } = state;
    const isOpen = showRhythmAlert || epinephrineDue;

    if (!isOpen) return null;

    let content;

    if (showRhythmAlert) {
        content = {
            type: 'rhythm',
            borderColor: 'border-brand-accent-yellow',
            title: 'RHYTHM CHECK',
            subtitle: 'Assess patient rhythm and check for a pulse.',
            actions: [
                {
                    label: 'ROSC (Pulse Present)',
                    className: 'bg-green-600 hover:bg-green-500',
                    icon: <CheckCircleIcon className="h-8 w-8 mr-4" />,
                    onClick: () => dispatch({ type: 'LOG_EVENT', payload: { type: EventType.RHYTHM_CHECK_ROSC, details: 'Pulse present', actor: 'System' } })
                },
                {
                    label: 'Pulseless',
                    className: 'bg-red-600 hover:bg-red-500',
                    icon: <XCircleIcon className="h-8 w-8 mr-4" />,
                    onClick: () => {
                         dispatch({ type: 'LOG_EVENT', payload: { type: EventType.RHYTHM_CHECK_PULSELESS, details: 'No pulse detected', actor: 'System' } });
                         dispatch({ type: 'OPEN_MODAL', payload: { type: 'rhythm-classification' } });
                    }
                }
            ],
            onDismiss: () => dispatch({ type: 'DISMISS_RHYTHM_ALERT' })
        };
    } else { // epinephrineDue
        content = {
            type: 'epinephrine',
            borderColor: 'border-brand-accent-red',
            title: 'EPINEPHRINE DUE',
            subtitle: 'Administer 1mg Epinephrine IV/IO now.',
            actions: [
                {
                    label: 'Administer Epinephrine (1mg)',
                    className: 'bg-blue-600 hover:bg-blue-500',
                    icon: <SyringeIcon className="h-8 w-8 mr-4" />,
                    onClick: () => dispatch({ type: 'LOG_EVENT', payload: { type: EventType.EPINEPHRINE_ADMINISTERED, details: '1mg IV Push', medicationName: 'Epinephrine', actor: 'System' } })
                }
            ],
            onDismiss: () => dispatch({ type: 'DISMISS_EPINEPHRINE_DUE_ALERT' })
        };
    }

    return (
        <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4 animate-fade-in">
            <div className={`bg-brand-card rounded-2xl shadow-2xl w-full max-w-2xl border-t-8 ${content.borderColor} flex flex-col items-center p-8 text-center`}>
                <BellAlertIcon className={`h-20 w-20 mb-4 ${content.type === 'rhythm' ? 'text-yellow-400' : 'text-red-400'} animate-pulse`} />
                <h2 className="text-5xl font-extrabold tracking-wider mb-2">{content.title}</h2>
                <p className="text-slate-300 text-xl mb-8">{content.subtitle}</p>
                <div className="w-full space-y-4">
                    {content.actions.map((action: any) => (
                        <button key={action.label} onClick={action.onClick} className={`${action.className} text-white font-bold py-4 px-6 rounded-lg w-full text-2xl flex items-center justify-center transition-transform hover:scale-105`}>
                            {action.icon}
                            {action.label}
                        </button>
                    ))}
                </div>
                <button onClick={content.onDismiss} className="mt-6 text-slate-400 hover:text-white font-semibold py-2 px-4 transition-colors">
                    Dismiss
                </button>
            </div>
        </div>
    );
};

const CodeScreen: React.FC<{ state: AppState, dispatch: React.Dispatch<Action>, onOpenSettings: () => void }> = ({ state, dispatch, onOpenSettings }) => (
  <main className="p-6 max-w-7xl mx-auto">
    <Header onEndCode={() => { saveCodeToHistory(state); dispatch({ type: 'END_CODE' }); }} codeStatus={state.codeStatus} patientDetails={state.patientDetails} onOpenSettings={onOpenSettings} />
    <PatientInfo details={state.patientDetails} dispatch={dispatch} />
    {state.showPrepareEpiAlert && <PrepareEpiAlert dispatch={dispatch} />}
    
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {/* Column 1: Actions & Log */}
        <div className="lg:col-span-1 xl:col-span-1 flex flex-col gap-6">
            <EventRecording 
                dispatch={dispatch} 
                lastShockEnergy={state.lastShockEnergy} 
                timers={state.timers}
                summaryCounts={state.summaryCounts}
                showNoFlowAlert={state.showNoFlowAlert}
            />
            <EventLog events={state.events} startTime={state.startTime} dispatch={dispatch} codeStatus={state.codeStatus} />
        </div>

        {/* Column 2: Timers & Summaries */}
        <div className="lg:col-span-1 xl:col-span-2 flex flex-col gap-6">
            <Card className="items-center justify-center h-40">
                <p className="text-slate-400 text-lg mb-2">CODE DURATION</p>
                <h1 className="text-6xl font-mono font-bold tracking-wider">{formatTime(state.elapsedTime)}</h1>
            </Card>
            
            <GuidedActions state={state} dispatch={dispatch} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <TimerDisplay label="RHYTHM CHECK" time={state.timers.rhythmCheck} active={state.timers.rhythmCheck !== null} activeColor="text-yellow-400" activeBgColor="bg-brand-accent-yellow" />
                <TimerDisplay 
                    label="EPINEPHRINE" 
                    time={state.timers.epinephrine} 
                    active={state.timers.epinephrine !== null}
                    activeColor="text-blue-400" 
                    activeBgColor="bg-brand-accent-blue"
                />
            </div>
            
            <SummaryCounts counts={state.summaryCounts} lastShockEnergy={state.lastShockEnergy} />
            <SuggestedActions state={state} dispatch={dispatch} />
            <TimerSettings settings={state.timerSettings} dispatch={dispatch} />
        </div>
    </div>
  </main>
);

const SummaryScreen: React.FC<{ state: AppState, dispatch: React.Dispatch<Action>, onOpenSettings: () => void }> = ({ state, dispatch, onOpenSettings }) => {
    // Determine if we are viewing a history record or a fresh summary
    const isHistoryView = state.codeStatus === 'history_view';
    const sourceData = isHistoryView && state.viewingHistoryRecord ? state.viewingHistoryRecord : state;
    
    // --- Data processing for detailed summary ---
    const chronologicalEvents = [...sourceData.events].reverse();

    // 1. Calculate Total Compression Time
    let totalCompressionTime = 0;
    let compressionStartTime: number | null = null;
    chronologicalEvents.forEach(event => {
        if (event.type === EventType.COMPRESSIONS_START && compressionStartTime === null) {
            compressionStartTime = event.timestamp;
        } else if (
            (event.type === EventType.RHYTHM_CHECK_PULSELESS || event.type === EventType.RHYTHM_CHECK_ROSC) 
            && compressionStartTime !== null
        ) {
            totalCompressionTime += event.timestamp - compressionStartTime;
            compressionStartTime = null;
        }
    });
    // If compressions were running when code ended
    if (compressionStartTime !== null) {
        totalCompressionTime += sourceData.elapsedTime - compressionStartTime;
    }

    const shockEvents = chronologicalEvents.filter(e => e.type === EventType.SHOCK_DELIVERED);
    const medicationEvents = chronologicalEvents.filter(e => 
        e.type === EventType.EPINEPHRINE_ADMINISTERED || 
        e.type === EventType.AMIODARONE_ADMINISTERED ||
        e.type === EventType.LIDOCAINE_ADMINISTERED ||
        e.type === EventType.OTHER_MEDICATION
    );
    
    const medicationSummary = React.useMemo(() => {
        const summaryMap = new Map<string, {name: string, dose: string, count: number}>();
        medicationEvents.forEach(event => {
            let name = event.medicationName;
            if (!name) {
                 switch(event.type) {
                    case EventType.EPINEPHRINE_ADMINISTERED: name = 'Epinephrine'; break;
                    case EventType.AMIODARONE_ADMINISTERED: name = 'Amiodarone'; break;
                    case EventType.LIDOCAINE_ADMINISTERED: name = 'Lidocaine'; break;
                    case EventType.OTHER_MEDICATION: name = 'Other Medication'; break;
                    default: name = event.type;
                }
            }
            const dose = event.details || 'Unknown Dose';
            const key = `${name}|${dose}`;
            if (summaryMap.has(key)) {
                summaryMap.get(key)!.count++;
            } else {
                summaryMap.set(key, { name, dose, count: 1 });
            }
        });
        return Array.from(summaryMap.values());
    }, [medicationEvents]);

    interface TimelineSegment {
        status: 'Pulseless' | 'ROSC';
        startTime: number;
        endTime: number;
        duration: number;
    }
    const timeline: TimelineSegment[] = [];
    let lastTimestamp = 0;
    let currentStatus: 'Pulseless' | 'ROSC' = 'Pulseless'; // Assume pulseless from the start

    chronologicalEvents.forEach(event => {
        if (event.type === EventType.RHYTHM_CHECK_ROSC || event.type === EventType.RHYTHM_CHECK_PULSELESS) {
            const segmentEndTime = event.timestamp;
            if (segmentEndTime > lastTimestamp) {
                timeline.push({
                    status: currentStatus,
                    startTime: lastTimestamp,
                    endTime: segmentEndTime,
                    duration: segmentEndTime - lastTimestamp,
                });
            }
            currentStatus = event.type === EventType.RHYTHM_CHECK_ROSC ? 'ROSC' : 'Pulseless';
            lastTimestamp = segmentEndTime;
        }
    });
    // Add final segment from last event to end of code
    if (sourceData.elapsedTime > lastTimestamp) {
        timeline.push({
            status: currentStatus,
            startTime: lastTimestamp,
            endTime: sourceData.elapsedTime,
            duration: sourceData.elapsedTime - lastTimestamp,
        });
    }

    const formatAbsoluteTime = (startTime: number, elapsedSeconds: number) => {
      return new Date(startTime + elapsedSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    const handleExportCSV = () => {
        const { patientDetails, summaryCounts, events, startTime, elapsedTime } = sourceData;
        
        const csvRows = [];
        
        // Patient Info
        csvRows.push(['Patient Details']);
        csvRows.push(['HN', patientDetails.hn]);
        csvRows.push(['Name', patientDetails.name]);
        csvRows.push(['Age', patientDetails.age]);
        csvRows.push(['Sex', patientDetails.sex]);
        csvRows.push(['Diagnosis', patientDetails.diagnosis]);
        csvRows.push([]);
        
        // Summary
        csvRows.push(['Code Summary']);
        csvRows.push(['Total Duration', formatTime(elapsedTime)]);
        csvRows.push(['Total Shocks', summaryCounts.shocks]);
        csvRows.push(['Total Epinephrine', summaryCounts.epinephrine]);
        csvRows.push(['Total Amiodarone (mg)', summaryCounts.amiodarone]);
        csvRows.push(['Total Lidocaine (mg)', summaryCounts.lidocaine]);
        csvRows.push([]);
        
        // Events
        csvRows.push(['Event Log']);
        csvRows.push(['Time (Code)', 'Time (Actual)', 'Event Type', 'Details', 'Actor']);
        
        [...events].reverse().forEach(event => {
            const codeTime = formatTime(event.timestamp);
            const actualTime = startTime ? new Date(startTime + event.timestamp * 1000).toLocaleTimeString() : '-';
            // Escape fields that might contain commas
            const cleanDetails = event.details ? `"${event.details.replace(/"/g, '""')}"` : '';
            csvRows.push([codeTime, actualTime, event.type, cleanDetails, event.actor || '']);
        });
        
        const csvContent = "data:text/csv;charset=utf-8," 
            + csvRows.map(e => e.join(",")).join("\n");
            
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `CPR_Record_${patientDetails.hn || 'Unknown'}_${new Date().toISOString().slice(0,10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
    <main className="p-6 max-w-4xl mx-auto">
        <Header onEndCode={() => {}} codeStatus={isHistoryView ? 'history_view' : 'review'} patientDetails={sourceData.patientDetails} onOpenSettings={onOpenSettings} />
        <div className="bg-brand-card rounded-lg p-6 mb-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-3xl font-bold">{isHistoryView ? 'Historical Code Review' : 'Code Event Summary'}</h2>
                    <p className="text-slate-400">{isHistoryView ? 'Reviewing a previously saved code event.' : 'This code has been ended. Review the summary below.'}</p>
                </div>
                <div className="flex space-x-4">
                     <button 
                        onClick={handleExportCSV} 
                        className="bg-brand-subtle hover:bg-slate-600 transition-opacity text-white font-bold py-3 px-6 rounded-lg text-lg flex items-center justify-center"
                    >
                        <ArrowDownTrayIcon className="h-6 w-6 mr-2"/> Export Log
                    </button>
                    {!isHistoryView ? (
                        <button 
                            onClick={() => dispatch({ type: 'RESET_APP' })} 
                            className="bg-brand-accent-yellow hover:bg-yellow-600 transition-opacity text-brand-dark font-bold py-3 px-6 rounded-lg text-lg flex items-center justify-center"
                        >
                            <PlayIcon className="h-6 w-6 mr-2"/> Start New Code
                        </button>
                    ) : (
                         <button 
                            onClick={() => dispatch({ type: 'CLOSE_HISTORY_VIEW' })} 
                            className="bg-brand-subtle hover:opacity-90 transition-opacity text-white font-bold py-3 px-6 rounded-lg text-lg flex items-center justify-center"
                        >
                            <ArrowLeftIcon className="h-6 w-6 mr-2"/> Back to Home
                        </button>
                    )}
                </div>
            </div>
        </div>

        <div className="flex flex-col gap-6">
            <Card className="items-center justify-center">
                <p className="text-slate-400 text-lg mb-2">FINAL CODE DURATION</p>
                <h1 className="text-7xl font-mono font-bold tracking-wider">{formatTime(sourceData.elapsedTime)}</h1>
            </Card>

            <Card title="Outcome Timeline" icon={<ClockIcon className="h-6 w-6" />}>
                <div className="space-y-3">
                    {timeline.map((segment, index) => (
                        <div key={index} className="flex items-center gap-4 bg-brand-dark/50 p-3 rounded-lg">
                            {segment.status === 'ROSC' ? <CheckCircleIcon className="h-6 w-6 text-green-400 flex-shrink-0" /> : <XCircleIcon className="h-6 w-6 text-red-400 flex-shrink-0" />}
                            <span className={`font-bold text-lg ${segment.status === 'ROSC' ? 'text-green-400' : 'text-red-400'}`}>{segment.status}</span>
                            <div className="flex-grow text-right space-x-4">
                                <span className="text-slate-300 font-mono">Duration: <span className="font-semibold">{formatTime(segment.duration)}</span></span>
                                <span className="text-slate-400 text-sm font-mono">({formatTime(segment.startTime)} - {formatTime(segment.endTime)})</span>
                            </div>
                        </div>
                    ))}
                </div>
            </Card>

             <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card title="Compression Summary" icon={<HeartbeatIcon className="h-6 w-6"/>}>
                    <div className="text-center">
                        <p className="text-4xl font-bold text-green-400">{formatTime(totalCompressionTime)}</p>
                        <p className="text-slate-400 text-sm">Total Compression Time</p>
                    </div>
                </Card>
                 <Card title="Total Shocks" icon={<BoltIcon className="h-6 w-6"/>}>
                    <div className="text-center">
                        <p className="text-4xl font-bold text-yellow-400">{shockEvents.length}</p>
                        <p className="text-slate-400 text-sm">Total Shocks Delivered</p>
                    </div>
                </Card>
            </div>

            <Card title="Shock History" icon={<BoltIcon className="h-6 w-6"/>}>
                {shockEvents.length > 0 ? (
                    <table className="w-full text-left">
                        <thead>
                            <tr className="border-b border-brand-subtle text-slate-400 text-sm">
                                <th className="p-2">#</th>
                                <th className="p-2">Energy</th>
                                <th className="p-2">Time in Code</th>
                                <th className="p-2">Actual Time</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shockEvents.map((event, index) => (
                                <tr key={event.id} className="border-b border-brand-dark/50">
                                    <td className="p-2 font-bold text-yellow-400">{index + 1}</td>
                                    <td className="p-2">{event.details}</td>
                                    <td className="p-2 font-mono">{formatTime(event.timestamp)}</td>
                                    <td className="p-2 font-mono text-slate-400">{sourceData.startTime ? formatAbsoluteTime(sourceData.startTime, event.timestamp) : ''}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : <p className="text-slate-400 text-center py-4">No shocks were delivered.</p>}
            </Card>

            <Card title="Medication Summary (Disbursement)" icon={<SyringeIcon className="h-6 w-6"/>}>
                {medicationSummary.length > 0 ? (
                     <table className="w-full text-left">
                        <thead>
                            <tr className="border-b border-brand-subtle text-slate-400 text-sm">
                                <th className="p-2">Medication</th>
                                <th className="p-2">Dose</th>
                                <th className="p-2 text-right">Count</th>
                            </tr>
                        </thead>
                        <tbody>
                            {medicationSummary.map((item, index) => (
                                <tr key={index} className="border-b border-brand-dark/50">
                                    <td className="p-2 font-semibold">{item.name}</td>
                                    <td className="p-2">{item.dose}</td>
                                    <td className="p-2 font-mono text-right">{item.count}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ): <p className="text-slate-400 text-center py-4">No medications were administered.</p>}
            </Card>
            
            <EventLog events={sourceData.events} startTime={sourceData.startTime} dispatch={dispatch} codeStatus={isHistoryView ? 'history_view' : 'review'} />
        </div>
    </main>
    );
};


const StartScreen: React.FC<{ onStart: () => void, onLoadState: (state: AppState) => void, previousStateStatus: CodeStatus | 'none', onOpenSettings: () => void, onReviewHistory: (record: SavedCodeRecord) => void }> = ({ onStart, onLoadState, previousStateStatus, onOpenSettings, onReviewHistory }) => {
    
    const lastHistoryItem = getLastSavedHistoryRecord();
    const canResume = previousStateStatus === 'active';
    const canReview = previousStateStatus === 'review' || !!lastHistoryItem;

    const handleAction = () => {
        if (canResume) {
            // Resume active session
            const savedStateJSON = localStorage.getItem(CPR_STATE_KEY);
            if (savedStateJSON) {
                const savedState = JSON.parse(savedStateJSON);
                onLoadState(savedState);
            }
        } else if (lastHistoryItem) {
            // Review historical session (read-only)
            onReviewHistory(lastHistoryItem);
        }
    };

    const buttonText = canResume ? 'Resume Code' : 'Review Last Code';
    const buttonColor = canResume ? 'bg-brand-accent-blue' : 'bg-brand-subtle';
    const isDisabled = !canResume && !lastHistoryItem;

    return (
        <div className="flex flex-col items-center justify-center min-h-screen text-center p-4 relative">
            <button 
                onClick={onOpenSettings}
                className="absolute top-6 right-6 p-3 rounded-full bg-brand-card border border-brand-subtle text-slate-400 hover:text-white hover:bg-brand-subtle transition-all"
                title="Settings & Admin"
            >
                <Cog6ToothIcon className="h-8 w-8" />
            </button>

            <HeartbeatIcon className="h-24 w-24 mb-4"/>
            <h1 className="text-5xl font-bold mb-2">BPK CPR Tracker</h1>
            <p className="text-slate-400 max-w-xl mb-8">
                A digital application to streamline and improve the documentation of in-hospital cardiac arrest events.
            </p>
            <div className="flex items-center space-x-4">
                <button onClick={onStart} className="bg-brand-accent-yellow hover:opacity-90 transition-opacity text-white font-bold py-4 px-8 rounded-lg text-2xl flex items-center justify-center">
                    <PlayIcon className="h-8 w-8 mr-3"/> Start New Code
                </button>
                <button 
                    onClick={handleAction} 
                    disabled={isDisabled}
                    className={`${buttonColor} hover:opacity-90 transition-opacity text-white font-bold py-4 px-8 rounded-lg text-2xl flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-brand-subtle`}
                >
                    {buttonText}
                </button>
            </div>
            {canResume && 
                <p className="text-sm text-slate-500 mt-4">An interrupted active session is available.</p>
            }
        </div>
    );
};


const App = () => {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [isInitialized, setIsInitialized] = useState(false);
  const [previousStateStatus, setPreviousStateStatus] = useState<CodeStatus | 'none'>('none');
  const [showSettings, setShowSettings] = useState(false);

  // Main timer tick
  useEffect(() => {
    if (state.codeStatus === 'active') {
      const timer: ReturnType<typeof setInterval> = setInterval(() => {
        dispatch({ type: 'TICK' });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [state.codeStatus]);
  
  const loadState = useCallback((savedState: AppState) => {
    dispatch({ type: 'LOAD_STATE', payload: savedState });
  }, []);
  
  const reviewHistoryRecord = useCallback((record: SavedCodeRecord) => {
      dispatch({ type: 'VIEW_HISTORY_RECORD', payload: record });
  }, []);

  // Check for saved state on initial mount
  useEffect(() => {
    if(!isInitialized){
        try {
            const savedStateJSON = localStorage.getItem(CPR_STATE_KEY);
            if (savedStateJSON) {
                const savedState = JSON.parse(savedStateJSON);
                setPreviousStateStatus(savedState.codeStatus || 'inactive');
            } else {
                setPreviousStateStatus('none');
            }
        } catch (error) {
            console.error("Failed to check state from localStorage", error);
            setPreviousStateStatus('none');
        } finally {
            setIsInitialized(true);
        }
    }
  }, [isInitialized]);

  // Save state to localStorage whenever CRITICAL data changes, NOT every tick.
  useEffect(() => {
    if (isInitialized) {
        try {
            if (state.codeStatus !== 'inactive' && state.codeStatus !== 'history_view') {
                 const stateToSave = { ...state, modal: initialState.modal, previousState: null, showRhythmAlert: false, showPrepareEpiAlert: false, showNoFlowAlert: false };
                 localStorage.setItem(CPR_STATE_KEY, JSON.stringify(stateToSave));
                 setPreviousStateStatus(state.codeStatus);
            } else if (state.codeStatus === 'inactive') {
                 localStorage.removeItem(CPR_STATE_KEY);
                 setPreviousStateStatus('none');
            }
        } catch (error) {
            console.error("Failed to save state to localStorage", error);
        }
    }
  }, [state.events, state.codeStatus, state.patientDetails, state.summaryCounts, state.algorithmState, isInitialized]); 
  
  const handleStart = () => {
      if(previousStateStatus !== 'none') {
          if(!window.confirm('Starting a new code will clear the previous session. Are you sure?')) {
              return;
          }
      }
      dispatch({type: 'RESET_APP'});
      dispatch({type: 'START_CODE'});
  };

  if (!isInitialized) {
      return null; // or a loading spinner
  }

  const renderContent = () => {
    switch (state.codeStatus) {
        case 'active':
            return <CodeScreen state={state} dispatch={dispatch} onOpenSettings={() => setShowSettings(true)} />;
        case 'review':
        case 'history_view':
            return <SummaryScreen state={state} dispatch={dispatch} onOpenSettings={() => setShowSettings(true)} />;
        case 'inactive':
        default:
            return <StartScreen onStart={handleStart} onLoadState={loadState} previousStateStatus={previousStateStatus} onOpenSettings={() => setShowSettings(true)} onReviewHistory={reviewHistoryRecord} />;
    }
  };

  return (
    <>
        <AlertModal state={state} dispatch={dispatch} />
        <Modal 
            modalState={state.modal} 
            dispatch={dispatch} 
            reversibleCauses={state.reversibleCauses} 
            algorithmState={state.algorithmState} 
            lastShockEnergy={state.lastShockEnergy} 
        />
        <GlobalSettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} dispatch={dispatch} />
        {renderContent()}
    </>
  );
};

export default App;

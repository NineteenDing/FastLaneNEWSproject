import {parseMediaRecognition} from './media-transcription.ts';

/** Whisper may place the last token slightly past EOF; preserve text and strict validation. */
export function parseLocalAsrRecognition(input: unknown) {
 let value=input;
 if(input && typeof input==='object' && !Array.isArray(input)) {
  const row=input as Record<string,unknown>,duration=row.durationSeconds;
  if(typeof duration==='number' && Number.isFinite(duration) && duration>0 && Array.isArray(row.segments)) {
   const segments=row.segments.map(segment=>{
    if(!segment || typeof segment!=='object' || Array.isArray(segment))return segment;
    const s=segment as Record<string,unknown>;
    return typeof s.start==='number' && s.start<duration && typeof s.end==='number' && s.end>duration && s.end<=duration+1
     ? {...s,end:duration} : segment;
   });
   value={...row,segments};
  }
 }
 return parseMediaRecognition(value);
}

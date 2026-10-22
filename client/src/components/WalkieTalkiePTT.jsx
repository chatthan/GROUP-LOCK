import React, { useState, useEffect, useRef } from 'react';
import {
  playMicClick,
  playRogerBeep,
  getVoiceSettings,
  saveVoiceSettings,
  speakVoiceAlert,
  testVoiceAlert,
} from '../utils/audioAlerts';

export default function WalkieTalkiePTT({
  socket,
  rideId,
  isLeader = false,
  isSweep = false,
  activeRidersCount = 1,
  channel: externalChannel,
  setChannel: externalSetChannel,
  isMuted: externalIsMuted,
  setIsMuted: externalSetIsMuted,
  voiceSettings: externalVoiceSettings,
  setVoiceSettings: externalSetVoiceSettings,
}) {
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [incomingSpeaker, setIncomingSpeaker] = useState(null); // { name, role, channel, timestamp }

  const [internalChannel, setInternalChannel] = useState('CONVOY');
  const channel = externalChannel !== undefined ? externalChannel : internalChannel;
  const setChannel = externalSetChannel || setInternalChannel;

  const [internalVoiceSettings, setInternalVoiceSettings] = useState(getVoiceSettings);
  const voiceSettings = externalVoiceSettings !== undefined ? externalVoiceSettings : internalVoiceSettings;
  const setVoiceSettings = externalSetVoiceSettings || setInternalVoiceSettings;

  const [internalIsMuted, setInternalIsMuted] = useState(false);
  const isMuted = externalIsMuted !== undefined ? externalIsMuted : internalIsMuted;
  const setIsMuted = externalSetIsMuted || setInternalIsMuted;

  const [micPermissionError, setMicPermissionError] = useState('');
  const [isRecordingReady, setIsRecordingReady] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordStartTimeRef = useRef(0);
  const audioPlayerRef = useRef(null);
  const transmitTimeoutRef = useRef(null);

  // Initialize and listen to socket PTT events
  useEffect(() => {
    if (!socket) return;

    const handleUserTransmitting = (data) => {
      if (isMuted) return;
      setIncomingSpeaker(data);
      playMicClick(true);
    };

    const handleAudioReceived = (data) => {
      if (isMuted) return;
      if (!data.audioBlob) return;

      try {
        if (!audioPlayerRef.current) {
          audioPlayerRef.current = new Audio();
        }
        const audio = audioPlayerRef.current;
        audio.src = data.audioBlob;
        audio.volume = Math.max(0.2, voiceSettings.volume || 1.0);

        audio.onended = () => {
          playRogerBeep();
          setIncomingSpeaker(null);
        };

        audio.onerror = () => {
          setIncomingSpeaker(null);
        };

        audio.play().catch((err) => {
          console.warn('[PTT] Autoplay blocked or audio playback error:', err);
          setIncomingSpeaker(null);
        });
      } catch (err) {
        console.error('[PTT] Audio playback error:', err);
        setIncomingSpeaker(null);
      }
    };

    const handleUserStopped = () => {
      // Small timeout lets audio finish or clears speaker
      setTimeout(() => {
        setIncomingSpeaker(null);
      }, 500);
    };

    socket.on('ptt:user_transmitting', handleUserTransmitting);
    socket.on('ptt:audio_received', handleAudioReceived);
    socket.on('ptt:user_stopped', handleUserStopped);

    return () => {
      socket.off('ptt:user_transmitting', handleUserTransmitting);
      socket.off('ptt:audio_received', handleAudioReceived);
      socket.off('ptt:user_stopped', handleUserStopped);
    };
  }, [socket, isMuted, voiceSettings.volume]);

  // Request or prepare microphone stream
  const startRecording = async () => {
    if (isTransmitting) return;
    setMicPermissionError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioChunksRef.current = [];
      recordStartTimeRef.current = Date.now();

      // Check supported MIME type
      let mimeType = 'audio/webm;codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        if (MediaRecorder.isTypeSupported('audio/webm')) {
          mimeType = 'audio/webm';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
          mimeType = 'audio/ogg;codecs=opus';
        } else {
          mimeType = ''; // Let browser default
        }
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const duration = (Date.now() - recordStartTimeRef.current) / 1000;
        // Release tracks
        stream.getTracks().forEach((track) => track.stop());

        if (audioChunksRef.current.length === 0 || duration < 0.3) {
          // Ignore accidental micro-clicks (<300ms)
          playMicClick(false);
          if (socket) {
            socket.emit('ride:ptt_stop', { rideId, channel });
          }
          return;
        }

        const blob = new Blob(audioChunksRef.current, { type: mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result;
          playMicClick(false);
          if (socket) {
            socket.emit('ride:ptt_audio', {
              rideId,
              audioBlob: base64Audio,
              duration,
              mimeType,
              channel,
            });
            socket.emit('ride:ptt_stop', { rideId, channel });
          }
        };
        reader.readAsDataURL(blob);
      };

      recorder.start(100);
      setIsTransmitting(true);
      playMicClick(true);

      if (socket) {
        socket.emit('ride:ptt_start', { rideId, channel });
      }

      // Max safety transmission cap: 15 seconds (prevents accidental live open mic)
      transmitTimeoutRef.current = setTimeout(() => {
        stopRecording();
      }, 15000);
    } catch (err) {
      console.error('[PTT] Microphone access failed:', err);
      setMicPermissionError('Microphone blocked. Please grant mic permissions to use Walkie-Talkie.');
      setIsTransmitting(false);
    }
  };

  const stopRecording = () => {
    if (transmitTimeoutRef.current) {
      clearTimeout(transmitTimeoutRef.current);
      transmitTimeoutRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {}
    }
    setIsTransmitting(false);
  };

  // Push-to-Talk 1-Tap click handler
  const handleToggleClick = () => {
    if (isTransmitting) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleSaveSettings = (updates) => {
    const updated = saveVoiceSettings(updates);
    setVoiceSettings(updated);
  };

  const isCommander = isLeader || isSweep;

  return (
    <>
      {/* 1. FLOATING / IN-HUD TRANSMISSION & INCOMING RADIO BANNER */}
      {incomingSpeaker && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-md bg-gradient-to-r from-amber-600 via-orange-600 to-amber-700 text-white px-4 py-2.5 rounded-2xl shadow-2xl border-2 border-amber-300 flex items-center justify-between gap-3 animate-pulse">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-2xl animate-bounce">📻</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-sm truncate">{incomingSpeaker.name}</span>
                <span className="text-[10px] bg-black/40 px-2 py-0.5 rounded-full font-bold uppercase tracking-wider text-amber-200">
                  {incomingSpeaker.channel === 'LEAD_SWEEP' ? '🛡️ Commander Line' : '📢 Convoy Radio'}
                </span>
              </div>
              <p className="text-[11px] text-amber-100 flex items-center gap-1.5 font-medium mt-0.5">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                Transmitting over helmet intercom...
              </p>
            </div>
          </div>
          {/* Animated sound wave bars */}
          <div className="flex items-end gap-1 h-6 shrink-0">
            <span className="w-1 bg-white rounded-full animate-[pulse_0.4s_ease-in-out_infinite] h-4" />
            <span className="w-1 bg-white rounded-full animate-[pulse_0.6s_ease-in-out_infinite] h-6" />
            <span className="w-1 bg-white rounded-full animate-[pulse_0.3s_ease-in-out_infinite] h-3" />
            <span className="w-1 bg-white rounded-full animate-[pulse_0.5s_ease-in-out_infinite] h-5" />
          </div>
        </div>
      )}

      {/* Permission Error Toast */}
      {micPermissionError && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-sm bg-red-600 text-white px-4 py-2.5 rounded-xl shadow-xl border border-red-400 text-xs flex items-center justify-between">
          <span>{micPermissionError}</span>
          <button
            onClick={() => setMicPermissionError('')}
            className="text-white/80 hover:text-white font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* 2. PTT QUICK ACCESS CHIP (Placed in Sliding Dashboard Ribbon) */}
      <div className="flex items-center shrink-0">
        {/* Walkie-Talkie PTT Button */}
        <button
          onClick={handleToggleClick}
          className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold transition shadow-md select-none shrink-0 ${
            isTransmitting
              ? 'bg-red-600 text-white ring-4 ring-red-500/50 animate-pulse'
              : 'bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white border border-emerald-400/50'
          }`}
          title="Push-To-Talk: Tap once to speak, tap again to send"
        >
          <span className="text-sm">{isTransmitting ? '🔴' : '🎙️'}</span>
          <span>{isTransmitting ? 'TRANSMITTING (Tap to Send)' : 'PTT Talk'}</span>
          {channel === 'LEAD_SWEEP' && (
            <span className="text-[9px] bg-purple-900 text-purple-200 px-1.5 py-0.2 rounded font-extrabold">
              CMD
            </span>
          )}
        </button>
      </div>
    </>
  );
}

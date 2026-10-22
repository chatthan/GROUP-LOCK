import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { getPlaceSuggestions } from '../services/ride.service';

function PlaceAutocompleteInput({
  label,
  value,
  onChange,
  onSelectPlace,
  placeholder = 'Search location or landmark',
  disabled = false,
  required = false,
  id,
  rightAction,
}) {
  const { token } = useAuth();
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const containerRef = useRef(null);
  const debounceTimerRef = useRef(null);

  // Dynamically load Google Maps Places script if API key is provided
  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (apiKey && !window.google?.maps?.places) {
      const existing = document.getElementById('google-maps-script');
      if (!existing) {
        const script = document.createElement('script');
        script.id = 'google-maps-script';
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
        script.async = true;
        document.head.appendChild(script);
      }
    }
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e) => {
    const query = e.target.value;
    onChange(query);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!query || query.trim().length < 2) {
      setSuggestions([]);
      setIsOpen(false);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await getPlaceSuggestions(query, token);
        setSuggestions(results || []);
        setIsOpen(results && results.length > 0);
        setHighlightedIndex(-1);
      } catch (err) {
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    }, 280);
  };

  const handleSelect = (place) => {
    onChange(place.description || place.mainText);
    if (onSelectPlace) {
      onSelectPlace(place);
    }
    setSuggestions([]);
    setIsOpen(false);
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e) => {
    if (!isOpen || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
        e.preventDefault();
        handleSelect(suggestions[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleClear = () => {
    onChange('');
    setSuggestions([]);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative w-full">
      {(label || rightAction) && (
        <div className="flex items-center justify-between gap-2 mb-1">
          {label ? (
            <label htmlFor={id} className="block text-xs font-medium text-slate-700">
              {label} {required && <span className="text-red-500">*</span>}
            </label>
          ) : <div />}
          {rightAction}
        </div>
      )}

      <div className="relative flex items-center">
        {/* Left Pin Icon */}
        <div className="absolute left-2.5 text-slate-400 pointer-events-none flex items-center">
          <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </div>

        <input
          id={id}
          type="text"
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setIsOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className="w-full text-sm border border-slate-300 rounded pl-8 pr-8 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-900 bg-white"
        />

        {/* Right status icon: Spinner or Clear */}
        <div className="absolute right-2 flex items-center">
          {isLoading ? (
            <div className="w-3.5 h-3.5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          ) : value && !disabled ? (
            <button
              type="button"
              onClick={handleClear}
              className="text-slate-400 hover:text-slate-600 p-0.5"
              title="Clear"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {/* Autocomplete Suggestions Dropdown */}
      {isOpen && suggestions.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-md shadow-lg divide-y divide-slate-100 text-left">
          {suggestions.map((suggestion, index) => {
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={suggestion.id || index}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => handleSelect(suggestion)}
                className={`px-3 py-2 cursor-pointer flex items-start gap-2.5 transition-colors ${
                  isHighlighted ? 'bg-emerald-50 text-slate-900' : 'hover:bg-slate-50 text-slate-800'
                }`}
              >
                <div className="mt-0.5 shrink-0 text-slate-400">
                  <svg className="w-4 h-4 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate text-slate-900">
                    {suggestion.mainText}
                  </p>
                  {suggestion.secondaryText && (
                    <p className="text-[11px] text-slate-500 truncate mt-0.5">
                      {suggestion.secondaryText}
                    </p>
                  )}
                </div>
                <span className="text-[9px] uppercase tracking-wider text-slate-400 shrink-0 mt-0.5 font-medium">
                  {suggestion.source === 'google' ? 'Google' : 'Maps'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default PlaceAutocompleteInput;

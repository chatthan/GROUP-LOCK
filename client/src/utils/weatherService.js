// GroupLock - Stage 10: Real-Time Open-Meteo Weather Service
// Zero API key required, highly reliable global road weather data

const weatherCache = new Map(); // Key: `${lat.toFixed(2)},${lng.toFixed(2)}`, Value: { data, timestamp }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes cache

// Interpret WMO Weather interpretation codes
function interpretWmoCode(code) {
  if (code === 0) {
    return {
      description: 'Clear Sky',
      icon: '☀️',
      roadCondition: 'Highway',
      speedLimit: 80,
      isHazardous: false,
    };
  }
  if ([1, 2, 3].includes(code)) {
    return {
      description: 'Partly Cloudy',
      icon: '⛅',
      roadCondition: 'Highway',
      speedLimit: 80,
      isHazardous: false,
    };
  }
  if ([45, 48].includes(code)) {
    return {
      description: 'Dense Fog / Mist',
      icon: '🌫️',
      roadCondition: 'Ghats/Hills',
      speedLimit: 50,
      isHazardous: true,
      warning: 'Low visibility! Maintain 4-second distance & use hazard lights.',
    };
  }
  if ([51, 53, 55, 56, 57].includes(code)) {
    return {
      description: 'Light Drizzle',
      icon: '🌦️',
      roadCondition: 'Rain/Wet',
      speedLimit: 60,
      isHazardous: true,
      warning: 'Drizzle makes roads slick. Smooth throttle & braking.',
    };
  }
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return {
      description: 'Rain / Wet Tarmac',
      icon: '🌧️',
      roadCondition: 'Rain/Wet',
      speedLimit: 50,
      isHazardous: true,
      warning: 'Wet roads detected! Reduce speed to 50 km/h and avoid white lane paint.',
    };
  }
  if ([95, 96, 99].includes(code)) {
    return {
      description: 'Thunderstorm',
      icon: '⛈️',
      roadCondition: 'Rain/Wet',
      speedLimit: 40,
      isHazardous: true,
      warning: 'Severe storm alert! Recommend convoy regroup at safe shelter.',
    };
  }
  return {
    description: 'Fair',
    icon: '🌤️',
    roadCondition: 'Highway',
    speedLimit: 80,
    isHazardous: false,
  };
}

export async function fetchLiveRoadWeather(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current_weather=true&hourly=precipitation_probability,rain`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Weather API returned ${res.status}`);

    const json = await res.json();
    const current = json.current_weather;
    if (!current) return null;

    const codeInfo = interpretWmoCode(current.weathercode);
    const hourlyRain = json.hourly?.rain ? json.hourly.rain[0] : 0;
    const precipProb = json.hourly?.precipitation_probability ? json.hourly.precipitation_probability[0] : 0;

    const weatherData = {
      temp: Math.round(current.temperature),
      windSpeed: Math.round(current.windspeed),
      weatherCode: current.weathercode,
      description: codeInfo.description,
      icon: codeInfo.icon,
      roadCondition: codeInfo.roadCondition,
      suggestedSpeedLimit: codeInfo.speedLimit,
      isHazardous: codeInfo.isHazardous,
      warning: codeInfo.warning || null,
      hourlyRain,
      precipProb,
      isDay: Boolean(current.is_day),
      fetchedAt: Date.now(),
    };

    weatherCache.set(cacheKey, { data: weatherData, timestamp: Date.now() });
    return weatherData;
  } catch (err) {
    console.warn('[WeatherService] Open-Meteo fetch failed:', err.message);
    return null;
  }
}

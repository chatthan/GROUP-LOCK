// GroupLock - Stage 10: Real-Time Open-Meteo Weather Service
// Zero API key required, highly reliable global road weather data

const weatherCache = new Map(); // Key: `${lat.toFixed(2)},${lng.toFixed(2)}`, Value: { data, timestamp }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

// Interpret WMO Weather interpretation codes with day/night awareness
function interpretWmoCode(code, isDay = true) {
  // 0: Clear sky
  if (code === 0) {
    return {
      description: isDay ? 'Clear Sky' : 'Clear Night',
      icon: isDay ? '☀️' : '🌙',
      roadCondition: 'Highway',
      speedLimit: 80,
      isHazardous: false,
    };
  }
  // 1: Mainly clear
  if (code === 1) {
    return {
      description: isDay ? 'Mainly Clear' : 'Fair Night',
      icon: isDay ? '🌤️' : '🌙',
      roadCondition: 'Highway',
      speedLimit: 80,
      isHazardous: false,
    };
  }
  // 2: Partly cloudy
  if (code === 2) {
    return {
      description: 'Partly Cloudy',
      icon: isDay ? '⛅' : '☁️',
      roadCondition: 'Highway',
      speedLimit: 80,
      isHazardous: false,
    };
  }
  // 3: Overcast
  if (code === 3) {
    return {
      description: 'Overcast',
      icon: '☁️',
      roadCondition: 'Highway',
      speedLimit: 80,
      isHazardous: false,
    };
  }
  // 45, 48: Fog / Mist
  if ([45, 48].includes(code)) {
    return {
      description: code === 48 ? 'Depositing Rime Fog' : 'Dense Fog / Mist',
      icon: '🌫️',
      roadCondition: 'Ghats/Hills',
      speedLimit: 50,
      isHazardous: true,
      warning: 'Low visibility! Maintain 4-second distance & use low beam.',
    };
  }
  // 51, 53, 55: Drizzle
  if ([51, 53, 55].includes(code)) {
    const desc = code === 51 ? 'Light Drizzle' : code === 53 ? 'Moderate Drizzle' : 'Dense Drizzle';
    return {
      description: desc,
      icon: '🌦️',
      roadCondition: 'Rain/Wet',
      speedLimit: 60,
      isHazardous: true,
      warning: 'Drizzle makes roads slick. Smooth throttle & gentle braking.',
    };
  }
  // 56, 57: Freezing Drizzle
  if ([56, 57].includes(code)) {
    return {
      description: 'Freezing Drizzle',
      icon: '🌨️',
      roadCondition: 'Rain/Wet',
      speedLimit: 40,
      isHazardous: true,
      warning: 'Freezing drizzle hazard! Extreme risk of black ice.',
    };
  }
  // 61, 63, 65: Rain (Slight, Moderate, Heavy)
  if ([61, 63, 65].includes(code)) {
    const desc = code === 61 ? 'Light Rain' : code === 63 ? 'Moderate Rain' : 'Heavy Rain';
    return {
      description: desc,
      icon: '🌧️',
      roadCondition: 'Rain/Wet',
      speedLimit: 50,
      isHazardous: true,
      warning: 'Wet tarmac detected! Reduce speed to 50 km/h and avoid white lane lines.',
    };
  }
  // 66, 67: Freezing Rain
  if ([66, 67].includes(code)) {
    return {
      description: 'Freezing Rain',
      icon: '🌨️',
      roadCondition: 'Rain/Wet',
      speedLimit: 40,
      isHazardous: true,
      warning: 'Freezing rain! High risk of icy roadway loss of control.',
    };
  }
  // 71, 73, 75, 77: Snowfall
  if ([71, 73, 75, 77].includes(code)) {
    const desc = code === 71 ? 'Slight Snow' : code === 73 ? 'Moderate Snow' : code === 75 ? 'Heavy Snow' : 'Snow Grains';
    return {
      description: desc,
      icon: '❄️',
      roadCondition: 'Ghats/Hills',
      speedLimit: 40,
      isHazardous: true,
      warning: 'Snowfall on roadway! Low grip, reduce speed immediately.',
    };
  }
  // 80, 81, 82: Rain Showers
  if ([80, 81, 82].includes(code)) {
    const desc = code === 80 ? 'Passing Showers' : code === 81 ? 'Heavy Showers' : 'Violent Downpour';
    return {
      description: desc,
      icon: '🌧️',
      roadCondition: 'Rain/Wet',
      speedLimit: 50,
      isHazardous: true,
      warning: 'Sudden rain showers! Beware of hydroplaning in water puddles.',
    };
  }
  // 85, 86: Snow Showers
  if ([85, 86].includes(code)) {
    return {
      description: 'Snow Showers',
      icon: '🌨️',
      roadCondition: 'Ghats/Hills',
      speedLimit: 40,
      isHazardous: true,
      warning: 'Snow showers active! Slippery mountain curves.',
    };
  }
  // 95, 96, 99: Thunderstorms
  if ([95, 96, 99].includes(code)) {
    const desc = code === 95 ? 'Thunderstorm' : 'Severe Thunderstorm & Hail';
    return {
      description: desc,
      icon: '⛈️',
      roadCondition: 'Rain/Wet',
      speedLimit: 40,
      isHazardous: true,
      warning: 'Severe storm alert! Recommend convoy regroup at safe shelter.',
    };
  }

  return {
    description: isDay ? 'Fair' : 'Fair Night',
    icon: isDay ? '🌤️' : '🌙',
    roadCondition: 'Highway',
    speedLimit: 80,
    isHazardous: false,
  };
}

export async function fetchLiveRoadWeather(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return null;
  }

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

    const isDay = current.is_day === undefined ? true : Boolean(current.is_day);
    const codeInfo = interpretWmoCode(current.weathercode, isDay);
    const hourlyRain = json.hourly?.rain ? json.hourly.rain[0] : 0;
    const precipProb = json.hourly?.precipitation_probability ? json.hourly.precipitation_probability[0] : 0;
    const roundedTemp = Math.round(current.temperature);
    const roundedWind = Math.round(current.windspeed);

    const weatherData = {
      // Both naming conventions supported for full backward/forward compatibility
      temperature: roundedTemp,
      temp: roundedTemp,
      condition: codeInfo.description,
      description: codeInfo.description,
      icon: codeInfo.icon,
      roadCondition: codeInfo.roadCondition,
      suggestedCondition: codeInfo.roadCondition,
      suggestedSpeedLimit: codeInfo.speedLimit,
      speedLimit: codeInfo.speedLimit,
      windSpeed: roundedWind,
      weatherCode: current.weathercode,
      isHazardous: codeInfo.isHazardous,
      caution: codeInfo.warning || null,
      warning: codeInfo.warning || null,
      hourlyRain,
      precipProb,
      isDay,
      fetchedAt: Date.now(),
    };

    weatherCache.set(cacheKey, { data: weatherData, timestamp: Date.now() });
    return weatherData;
  } catch (err) {
    console.warn('[WeatherService] Open-Meteo fetch failed:', err.message);
    // If cache has an older entry, return it on network failure
    if (cached?.data) return cached.data;
    return null;
  }
}

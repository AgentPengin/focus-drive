import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, Marker, NavigationControl, Source } from "react-map-gl/maplibre";
import type { MapLayerMouseEvent, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { motion, AnimatePresence } from "framer-motion";
import "./App.css";

interface LatLngLike {
  lat: number;
  lng: number;
}

type CoordTuple = [number, number]; // [lng, lat]

const DEFAULT_CENTER: LatLngLike = { lat: 21.0278, lng: 105.8342 };
const DEFAULT_STATUS = "Chọn điểm xuất phát và điểm đến để lập lộ trình.";
const MAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const MAP_FOLLOW_PITCH = 55;


function haversine(a: LatLngLike, b: LatLngLike) {
  const R = 6371e3;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  return R * c;
}

function pathLengthMeters(path: LatLngLike[]): number {
  if (path.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversine(path[i - 1], path[i]);
  return d;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function interpolateAlongPath(path: LatLngLike[], fraction: number): LatLngLike | null {
  if (!path.length) return null;
  if (fraction <= 0) return path[0];
  if (fraction >= 1) return path[path.length - 1];
  const total = pathLengthMeters(path);
  if (total === 0) return path[0];
  const target = total * fraction;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = haversine(path[i - 1], path[i]);
    if (acc + seg >= target) {
      const segFraction = (target - acc) / seg;
      return {
        lat: lerp(path[i - 1].lat, path[i].lat, segFraction),
        lng: lerp(path[i - 1].lng, path[i].lng, segFraction),
      };
    }
    acc += seg;
  }
  return path[path.length - 1];
}

function mmToMs(mins: number) {
  return Math.max(1, Math.round(mins)) * 60 * 1000;
}

function formatClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600).toString().padStart(2, "0");
  const mm = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function toCoordTuple(point: LatLngLike): CoordTuple {
  return [point.lng, point.lat];
}

function bearingDegrees(from: LatLngLike, to: LatLngLike): number {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const deg = (θ * 180) / Math.PI;
  return (deg + 360) % 360;
}

function headingAlongPath(path: LatLngLike[], fraction: number): number | null {
  if (path.length < 2) return null;
  const total = pathLengthMeters(path);
  if (total === 0) return null;
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  const target = total * clampedFraction;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = haversine(path[i - 1], path[i]);
    if (seg === 0) continue;
    if (acc + seg >= target) {
      return bearingDegrees(path[i - 1], path[i]);
    }
    acc += seg;
  }
  return bearingDegrees(path[path.length - 2], path[path.length - 1]);
}

function boundsFromCoords(coords: CoordTuple[]): maplibregl.LngLatBounds | null {
  if (!coords.length) return null;
  const bounds = coords.reduce(
    (b, coord) => b.extend(coord),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  );
  return bounds;
}

interface MarkerProps {
  glyph: string;
  variant: "start" | "end" | "car";
  rotationDeg?: number;
}

function MarkerPin({ glyph, variant, rotationDeg = 0 }: MarkerProps) {
  if (variant === "car") {
    return (
      <div className="fd-car-marker">
        <img
          src="/arrow2.png"
          alt="car"
          className="fd-car-image"
          style={{ transform: `rotate(${rotationDeg}deg)` }}
        />
      </div>
    );
  }
  const pinStyle = rotationDeg ? { transform: `rotate(${rotationDeg}deg)` } : undefined;
  return (
    <div className={`fd-marker fd-marker--${variant}`}>
      <span className="fd-marker__pin" style={pinStyle}>
        <span className="fd-marker__glyph">{glyph}</span>
        <span className="fd-marker__tail" />
      </span>
    </div>
  );
}

export default function App() {
  const [start, setStart] = useState<LatLngLike | null>(null);
  const [end, setEnd] = useState<LatLngLike | null>(null);
  const [routePath, setRoutePath] = useState<LatLngLike[]>([]);

  const [mode, setMode] = useState<"idle" | "setStart" | "setEnd">("setStart");
  const [useOsrm, setUseOsrm] = useState(false);

  const [durationMin, setDurationMin] = useState(25);
  const [isRunning, setIsRunning] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [arrived, setArrived] = useState(false);
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);
  const [isPlanningRoute, setIsPlanningRoute] = useState(false);

  const animRef = useRef<number | null>(null);
  const mapRef = useRef<MapRef | null>(null);

  const planRoute = useCallback(async () => {
    if (!start || !end) {
      setStatusMessage("Cần chọn đủ điểm xuất phát và điểm đến trước khi lập lộ trình.");
      return;
    }
    setArrived(false);
    setElapsed(0);
    setIsRunning(false);
    setStartTime(null);
    setIsPlanningRoute(true);
    setStatusMessage("Đang tính toán lộ trình...");

    try {
      if (useOsrm) {
        const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`OSRM status ${res.status}`);
        const data = await res.json();
        const coords: [number, number][] = data?.routes?.[0]?.geometry?.coordinates || [];
        if (coords.length) {
          const path = coords.map(([lng, lat]) => ({ lat, lng }));
          setRoutePath(path);
          const km = (pathLengthMeters(path) / 1000).toFixed(2);
          setStatusMessage(`Lộ trình theo đường bộ đã sẵn sàng (${km} km).`);
          return;
        }
        throw new Error("OSRM returned no coordinates");
      }
    } catch (error) {
      console.warn("OSRM routing failed, falling back to straight line", error);
      setStatusMessage("Không lấy được tuyến đường OSRM, dùng đoạn thẳng giữa hai điểm.");
    } finally {
      setIsPlanningRoute(false);
    }

    const fallbackPath = [start, end];
    setRoutePath(fallbackPath);
    const fallbackKm = (pathLengthMeters(fallbackPath) / 1000).toFixed(2);
    if (!useOsrm) {
      setStatusMessage(`Lộ trình đường thẳng đã sẵn sàng (${fallbackKm} km).`);
    }
  }, [start, end, useOsrm]);

  useEffect(() => {
    if (!isRunning) {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      return;
    }
    const begin = startTime ?? Date.now();
    if (!startTime) setStartTime(begin);

    const tick = () => {
      const now = Date.now();
      const e = now - begin;
      const total = mmToMs(durationMin);
      setElapsed(Math.min(e, total));
      if (e >= total) {
        setIsRunning(false);
        setArrived(true);
        return;
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [isRunning, durationMin, startTime]);

  const totalDurationMs = useMemo(() => mmToMs(durationMin), [durationMin]);
  const progress = useMemo(() => {
    return totalDurationMs ? Math.min(1, elapsed / totalDurationMs) : 0;
  }, [elapsed, totalDurationMs]);
  const remainingMs = useMemo(() => Math.max(0, totalDurationMs - elapsed), [elapsed, totalDurationMs]);
  const carPos = useMemo(() => interpolateAlongPath(routePath, progress), [routePath, progress]);
  const totalMeters = useMemo(() => pathLengthMeters(routePath), [routePath]);
  const traveledMeters = useMemo(() => totalMeters * progress, [totalMeters, progress]);
  const totalKm = useMemo(() => (totalMeters / 1000).toFixed(2), [totalMeters]);
  const traveledKm = useMemo(() => (traveledMeters / 1000).toFixed(2), [traveledMeters]);
  const headingDeg = useMemo(() => headingAlongPath(routePath, progress), [routePath, progress]);

  const startCoord = useMemo<CoordTuple | null>(() => (start ? toCoordTuple(start) : null), [start]);
  const endCoord = useMemo<CoordTuple | null>(() => (end ? toCoordTuple(end) : null), [end]);
  const carCoord = useMemo<CoordTuple | null>(() => (carPos ? toCoordTuple(carPos) : null), [carPos]);
  const routeCoords = useMemo<CoordTuple[]>(() => routePath.map((point) => toCoordTuple(point)), [routePath]);
  const routeGeoJson = useMemo(() => {
    if (routeCoords.length < 2) return null;
    return {
      type: "Feature" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: routeCoords,
      },
      properties: {},
    };
  }, [routeCoords]);

  const activeHeadingDeg = useMemo(() => (isRunning && headingDeg != null ? headingDeg : 0), [isRunning, headingDeg]);
  const carMarkerRotation = useMemo(() => (isRunning ? 0 : headingDeg ?? 0), [isRunning, headingDeg]);

  useEffect(() => {
    const mapInstance = mapRef.current?.getMap();
    if (!mapInstance) return;
    if (!routeCoords.length) return;
    if (isRunning) return;

    if (routeCoords.length === 1) {
      mapInstance.easeTo({
        center: routeCoords[0],
        zoom: 14,
        bearing: 0,
        pitch: 0,
        duration: 800,
      });
      return;
    }

    const bounds = boundsFromCoords(routeCoords);
    if (bounds) {
      mapInstance.fitBounds(bounds, {
        padding: 120,
        duration: 900,
        maxZoom: 16,
      });
      mapInstance.easeTo({ bearing: 0, pitch: 0, duration: 1 });
    }
  }, [routeCoords, isRunning]);

  useEffect(() => {
    const mapInstance = mapRef.current?.getMap();
    if (!mapInstance) return;
    if (!isRunning) {
      if (mapInstance.getPitch() !== 0 || mapInstance.getBearing() !== 0) {
        mapInstance.easeTo({ bearing: 0, pitch: 0, duration: 600 });
      }
      return;
    }
    if (!carCoord) return;

    mapInstance.easeTo({
      center: carCoord,
      bearing: activeHeadingDeg,
      pitch: MAP_FOLLOW_PITCH,
      duration: 600,
      easing: (t) => 1 - Math.pow(1 - t, 3),
    });
  }, [carCoord, activeHeadingDeg, isRunning]);

  const canStart = routePath.length > 0 && !isRunning && !isPlanningRoute;
  const canPlan = Boolean(start && end && !isPlanningRoute);

  const interactionMessage = useMemo(() => {
    if (mode === "setStart") return "Click trên bản đồ để chọn điểm xuất phát.";
    if (mode === "setEnd") return "Tiếp tục chọn điểm đến.";
    if (routePath.length) return "Sẵn sàng! Nhấn Start để bắt đầu phiên tập trung.";
    return "Sử dụng các nút để đặt điểm bắt đầu và điểm đến.";
  }, [mode, routePath.length]);

  useEffect(() => {
    if (arrived) {
      setStatusMessage("🎉 Bạn đã hoàn thành lộ trình! Hít thở sâu và nghỉ ngơi nhé.");
    }
  }, [arrived]);

  const handleSetMode = useCallback(
    (nextMode: "idle" | "setStart" | "setEnd") => {
      setMode(nextMode);
      if (nextMode === "setStart") {
        setStatusMessage("Click trên bản đồ để chọn điểm xuất phát.");
      } else if (nextMode === "setEnd") {
        setStatusMessage("Chọn điểm đến trên bản đồ.");
      } else if (!routePath.length) {
        setStatusMessage(DEFAULT_STATUS);
      }
    },
    [routePath.length],
  );

  const handleSelectStart = useCallback((point: LatLngLike) => {
    setStart(point);
    setMode("setEnd");
    setStatusMessage("Điểm xuất phát đã được đặt. Chọn điểm đến tiếp theo.");
  }, []);

  const handleSelectEnd = useCallback((point: LatLngLike) => {
    setEnd(point);
    setMode("idle");
    setStatusMessage("Đã có điểm đến. Nhấn \"Lập lộ trình\" để tính toán.");
  }, []);

  const handleClearRoute = useCallback(() => {
    setStart(null);
    setEnd(null);
    setRoutePath([]);
    setIsRunning(false);
    setElapsed(0);
    setStartTime(null);
    setArrived(false);
    handleSetMode("setStart");
    setStatusMessage(DEFAULT_STATUS);
    const mapInstance = mapRef.current?.getMap();
    mapInstance?.easeTo({
      center: toCoordTuple(DEFAULT_CENTER),
      zoom: 13,
      bearing: 0,
      pitch: 0,
      duration: 800,
    });
  }, [handleSetMode]);

  const handleStartSession = useCallback(() => {
    if (!routePath.length) return;
    setIsRunning(true);
    setArrived(false);
    setStatusMessage("Phiên tập trung đang chạy. Cố lên!");
  }, [routePath.length]);

  const handlePauseSession = useCallback(() => {
    setIsRunning(false);
    setStatusMessage("Đã tạm dừng. Nhấn Start để tiếp tục.");
  }, []);

  const handleResetSession = useCallback(() => {
    setIsRunning(false);
    setElapsed(0);
    setStartTime(null);
    setArrived(false);
    setStatusMessage("Đã đặt lại phiên. Sẵn sàng khi bạn muốn.");
  }, []);

  const handleDurationChange = useCallback((value: number) => {
    if (Number.isNaN(value) || value <= 0) return;
    setDurationMin(Math.min(240, Math.round(value)));
  }, []);

  const handleMapClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const point = { lat: event.lngLat.lat, lng: event.lngLat.lng };
      if (mode === "setStart") {
        handleSelectStart(point);
      } else if (mode === "setEnd") {
        handleSelectEnd(point);
      }
    },
    [mode, handleSelectStart, handleSelectEnd],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-icon">🚗</span>
          <div>
            <div className="brand-title">FocusDrive</div>
            <div className="brand-sub">Tập trung qua từng km</div>
          </div>
        </div>
        <div className="session-meta">
          <div className={`session-chip ${arrived ? "chip-arrived" : isRunning ? "chip-running" : "chip-idle"}`}>
            {arrived ? "Đã đến đích" : isRunning ? "Đang tập trung" : "Đang tạm dừng"}
          </div>
          <div className="session-clock">{formatClock(remainingMs)}</div>
        </div>
      </header>

      <div className="app-body">
        <div className="map-panel">
          <div className="map-wrapper">
            <Map
              ref={(instance) => {
                mapRef.current = instance;
              }}
              mapLib={maplibregl}
              mapStyle={MAP_STYLE_URL}
              style={{ width: "100%", height: "100%" }}
              attributionControl={false}
              onClick={handleMapClick}
              initialViewState={{
                longitude: DEFAULT_CENTER.lng,
                latitude: DEFAULT_CENTER.lat,
                zoom: 13,
                pitch: 0,
                bearing: 0,
              }}
            >
              <NavigationControl position="bottom-right" visualizePitch />
              {routeGeoJson && (
                <Source id="route" type="geojson" data={routeGeoJson} lineMetrics>
                  <Layer
                    id="route-line"
                    type="line"
                    layout={{ "line-cap": "round", "line-join": "round" }}
                    paint={{
                      "line-color": [
                        "case",
                        ["<=", ["line-progress"], progress],
                        "#ef4444",
                        "#111827",
                      ],
                      "line-width": 5,
                      "line-opacity": 0.85,
                    }}
                  />
                </Source>
              )}
              {startCoord && (
                <Marker longitude={startCoord[0]} latitude={startCoord[1]} anchor="bottom">
                  <MarkerPin glyph="GO" variant="start" />
                </Marker>
              )}
              {endCoord && (
                <Marker longitude={endCoord[0]} latitude={endCoord[1]} anchor="bottom">
                  <MarkerPin glyph="🏁" variant="end" />
                </Marker>
              )}
              {carCoord && (
                <Marker longitude={carCoord[0]} latitude={carCoord[1]} anchor="center">
                  <MarkerPin glyph="🚗" variant="car" rotationDeg={carMarkerRotation} />
                </Marker>
              )}
            </Map>
            <div className="map-overlay">
              <span>{interactionMessage}</span>
            </div>
          </div>
        </div>

        <aside className="sidebar">
          <div className="status-banner">{statusMessage}</div>

          <section className="card route-card">
            <div className="card-header compact">
              <div>
                <h2>Trình lập lộ trình</h2>
                <p>Tạo tuyến đường lý tưởng cho phiên tập trung.</p>
              </div>
            </div>

            <div className="mode-buttons stack">
              <button
                className={`mode-button ${mode === "setStart" ? "is-active" : ""}`}
                onClick={() => handleSetMode("setStart")}
              >
                Đặt điểm xuất phát
              </button>
              <button
                className={`mode-button ${mode === "setEnd" ? "is-active" : ""}`}
                onClick={() => handleSetMode("setEnd")}
              >
                Đặt điểm đến
              </button>
              <button className="mode-button" onClick={() => handleSetMode("idle")}>Hoàn tất chọn</button>
            </div>

            <div className="route-controls">
              <label className="toggle">
                <input type="checkbox" checked={useOsrm} onChange={(e) => setUseOsrm(e.target.checked)} />
                <span className="toggle-indicator" />
                <span className="toggle-label">Ưu tiên tuyến đường thực tế (OSRM)</span>
              </label>
              <div className="route-buttons">
                <button className="primary" disabled={!canPlan} onClick={planRoute}>
                  {isPlanningRoute ? "Đang lập..." : "Lập lộ trình"}
                </button>
                <button className="ghost" onClick={handleClearRoute}>
                  Xoá lộ trình
                </button>
              </div>
            </div>

            <div className="route-stats">
              <div>
                <span className="label">Start</span>
                <strong>{start ? `${start.lat.toFixed(4)}, ${start.lng.toFixed(4)}` : "—"}</strong>
              </div>
              <div>
                <span className="label">Destination</span>
                <strong>{end ? `${end.lat.toFixed(4)}, ${end.lng.toFixed(4)}` : "—"}</strong>
              </div>
              <div>
                <span className="label">Chiều dài</span>
                <strong>{routePath.length ? `${totalKm} km` : "—"}</strong>
              </div>
            </div>
          </section>

          <section className="card session-card">
            <div className="card-header compact">
              <div>
                <h2>Phiên tập trung</h2>
                <p>Chọn thời lượng và điều khiển chuyến đi của bạn.</p>
              </div>
              <div className="progress-badge">{Math.round(progress * 100)}%</div>
            </div>

            <div className="duration-picker">
              {[25, 45, 60, 90, 120].map((m) => (
                <button
                  key={m}
                  className={`pill ${durationMin === m ? "is-active" : ""}`}
                  onClick={() => setDurationMin(m)}
                >
                  {m} phút
                </button>
              ))}
              <label className="custom-duration">
                <span>Tùy chỉnh</span>
                <input
                  type="number"
                  min={1}
                  max={240}
                  value={durationMin}
                  onChange={(e) => handleDurationChange(Number(e.target.value))}
                />
                <span>phút</span>
              </label>
            </div>

            <div className="timer-display">{formatClock(remainingMs)}</div>

            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>

            <div className="distance-readout">
              <div>
                <span className="label">Đã đi</span>
                <strong>{routePath.length ? `${traveledKm} km` : "—"}</strong>
              </div>
              <div>
                <span className="label">Tổng lộ trình</span>
                <strong>{routePath.length ? `${totalKm} km` : "—"}</strong>
              </div>
            </div>

            <div className="control-buttons">
              <button className="primary" disabled={!canStart} onClick={handleStartSession}>
                Bắt đầu
              </button>
              <button className="ghost" onClick={handlePauseSession}>
                Tạm dừng
              </button>
              <button className="ghost" onClick={handleResetSession}>
                Đặt lại
              </button>
            </div>

            <AnimatePresence>
              {arrived && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 16 }}
                  className="arrival-card"
                >
                  <div className="arrival-title">🎉 Đã đến đích</div>
                  <div className="arrival-sub">Ghi lại thành quả và thư giãn một chút nhé.</div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </aside>
      </div>

      <footer className="app-footer">
        Máy chủ OSRM là miễn phí công khai, đôi khi có thể chậm. Nếu gặp sự cố, hãy tắt tuỳ chọn và dùng lộ trình
        đường thẳng.
      </footer>
    </div>
  );
}

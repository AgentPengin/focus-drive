import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents } from "react-leaflet";
import L, { type LatLngExpression, type LeafletMouseEvent, type Map as LeafletMap } from "leaflet";
import { motion, AnimatePresence } from "framer-motion";
import "leaflet/dist/leaflet.css";
import "./App.css";

// Fix Leaflet default marker paths under bundlers (Vite/CRA)
import marker2x from "leaflet/dist/images/marker-icon-2x.png";
import marker from "leaflet/dist/images/marker-icon.png";
import shadow from "leaflet/dist/images/marker-shadow.png";
L.Icon.Default.mergeOptions({ iconUrl: marker, iconRetinaUrl: marker2x, shadowUrl: shadow });

interface LatLngLike {
  lat: number;
  lng: number;
}

const DEFAULT_CENTER: LatLngLike = { lat: 21.0278, lng: 105.8342 };
const DEFAULT_STATUS = "Chọn điểm xuất phát và điểm đến để lập lộ trình.";
const START_MARKER_HTML = "<span class='fd-marker__pin'><span class='fd-marker__glyph'>GO</span><span class='fd-marker__tail'></span></span>";
const END_MARKER_HTML = "<span class='fd-marker__pin'><span class='fd-marker__glyph'>🏁</span><span class='fd-marker__tail'></span></span>";
const CAR_MARKER_HTML = "<span class='fd-marker__pin'><span class='fd-marker__glyph'>🚗</span></span>";

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

function toLatLngExpression(point: LatLngLike): LatLngExpression {
  return [point.lat, point.lng] as [number, number];
}

function ClickCatcher({ onPick }: { onPick: (latlng: LatLngLike) => void }) {
  useMapEvents({
    click(e: LeafletMouseEvent) {
      onPick({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

export default function App() {
  const [start, setStart] = useState<LatLngLike | null>(null);
  const [end, setEnd] = useState<LatLngLike | null>(null);
  const [routePath, setRoutePath] = useState<LatLngLike[]>([]);

  const [mode, setMode] = useState<"idle" | "setStart" | "setEnd">("setStart");
  const [useOsrm, setUseOsrm] = useState(false);
  const [isPlanningRoute, setIsPlanningRoute] = useState(false);
  const [statusMessage, setStatusMessage] = useState(DEFAULT_STATUS);

  const [durationMin, setDurationMin] = useState(25);
  const [isRunning, setIsRunning] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [arrived, setArrived] = useState(false);

  const animRef = useRef<number | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);

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

  const mapCenter = useMemo<LatLngExpression>(() => {
    return start ? toLatLngExpression(start) : toLatLngExpression(DEFAULT_CENTER);
  }, [start]);
  const startPosition = useMemo<LatLngExpression | null>(
    () => (start ? toLatLngExpression(start) : null),
    [start],
  );
  const endPosition = useMemo<LatLngExpression | null>(() => (end ? toLatLngExpression(end) : null), [end]);
  const carPosition = useMemo<LatLngExpression | null>(() => (carPos ? toLatLngExpression(carPos) : null), [carPos]);
  const routePositions = useMemo<LatLngExpression[]>(
    () => routePath.map((point) => toLatLngExpression(point)),
    [routePath],
  );

  const handleMapInstance = useCallback((instance: LeafletMap | null) => {
    if (!instance) return;
    mapRef.current = instance;
    requestAnimationFrame(() => instance.invalidateSize());
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!routePath.length) return;
    if (isRunning) return;
    if (routePath.length === 1) {
      map.setView(routePath[0], map.getZoom(), { animate: true });
      return;
    }
    const bounds = L.latLngBounds(routePath.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [72, 72], maxZoom: 16 });
  }, [routePath, isRunning]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!carPos) return;
    if (!isRunning) return;
    map.panTo([carPos.lat, carPos.lng], { animate: true, duration: 0.6, easeLinearity: 0.25 });
  }, [carPos, isRunning]);

  const startIcon = useMemo(
    () =>
      L.divIcon({
        className: "leaflet-div-icon fd-marker fd-marker--start",
        html: START_MARKER_HTML,
        iconSize: [48, 58],
        iconAnchor: [24, 52],
      }),
    [],
  );
  const endIcon = useMemo(
    () =>
      L.divIcon({
        className: "leaflet-div-icon fd-marker fd-marker--end",
        html: END_MARKER_HTML,
        iconSize: [48, 58],
        iconAnchor: [24, 52],
      }),
    [],
  );
  const carIcon = useMemo(
    () =>
      L.divIcon({
        className: "leaflet-div-icon fd-marker fd-marker--car",
        html: CAR_MARKER_HTML,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      }),
    [],
  );

  const canStart = routePath.length > 0 && !isRunning && !isPlanningRoute;
  const canPlan = !!start && !!end && !isPlanningRoute;

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
    mapRef.current?.setView(DEFAULT_CENTER, 13, { animate: true });
    setStatusMessage(DEFAULT_STATUS);
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
          <div
            className={`session-chip ${arrived ? "chip-arrived" : isRunning ? "chip-running" : "chip-idle"}`}
          >
            {arrived ? "Đã đến đích" : isRunning ? "Đang tập trung" : "Đang tạm dừng"}
          </div>
          <div className="session-clock">{formatClock(remainingMs)}</div>
        </div>
      </header>

      <div className="app-body">
        <div className="map-panel">
          <div className="map-wrapper">
            <MapContainer
              center={mapCenter}
              zoom={13}
              className="map-canvas"
              scrollWheelZoom
              ref={handleMapInstance}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {startPosition && <Marker position={startPosition} icon={startIcon} />}
              {endPosition && <Marker position={endPosition} icon={endIcon} />}
              {routePositions.length > 0 && (
                <Polyline
                  pathOptions={{ weight: 6, opacity: 0.9 }}
                  positions={routePositions}
                />
              )}
              {carPosition && <Marker position={carPosition} icon={carIcon} />}
              {(mode === "setStart" || mode === "setEnd") && (
                <ClickCatcher
                  onPick={(point) => {
                    if (mode === "setStart") handleSelectStart(point);
                    else handleSelectEnd(point);
                  }}
                />
              )}
            </MapContainer>
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
                <button className="ghost" onClick={handleClearRoute}>Xoá lộ trình</button>
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
              <button className="ghost" onClick={handlePauseSession}>Tạm dừng</button>
              <button className="ghost" onClick={handleResetSession}>Đặt lại</button>
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

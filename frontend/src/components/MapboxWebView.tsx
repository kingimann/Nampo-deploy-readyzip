import React, { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet, View, Platform } from "react-native";
import { WebView } from "react-native-webview";
import { MAPBOX_TOKEN } from "@/src/api/client";

export type MarkerInput = {
  id: string;
  longitude: number;
  latitude: number;
  title?: string;
  color?: string;
  label?: string;
};

export type RouteGeometry = {
  type: "LineString";
  coordinates: [number, number][];
};

export type MapboxEvent =
  | { type: "ready" }
  | { type: "click"; lng: number; lat: number }
  | { type: "longpress"; lng: number; lat: number }
  | { type: "markerClick"; id: string }
  | { type: "userPan" }
  | { type: "moveEnd"; center: [number, number]; zoom: number; bearing: number; pitch: number };

export type MapboxWebViewHandle = {
  setStyle: (styleUrl: string) => void;
  setMarkers: (markers: MarkerInput[]) => void;
  setRoute: (geometry: RouteGeometry | null) => void;
  setAltRoutes: (geometries: RouteGeometry[]) => void;
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  panTo: (lng: number, lat: number) => void;
  setUserLocation: (lng: number, lat: number, accuracy?: number, heading?: number) => void;
  setPitch: (pitch: number) => void;
  setBearing: (bearing: number) => void;
  resetNorth: () => void;
  setTraffic: (on: boolean) => void;
  set3DBuildings: (on: boolean) => void;
  setLightPreset: (preset: "dawn" | "day" | "dusk" | "night") => void;
  fitBounds: (coordinates: [number, number][], padding?: number) => void;
};

type Props = {
  initialCenter: [number, number];
  initialZoom: number;
  initialStyle: string;
  onEvent?: (e: MapboxEvent) => void;
};

function buildHtml(token: string, center: [number, number], zoom: number, style: string) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="initial-scale=1, maximum-scale=1, user-scalable=no, width=device-width" />
<link href="https://api.mapbox.com/mapbox-gl-js/v3.24.0/mapbox-gl.css" rel="stylesheet" />
<script src="https://api.mapbox.com/mapbox-gl-js/v3.24.0/mapbox-gl.js"></script>
<style>
  html, body, #map { margin:0; padding:0; height:100%; width:100%; background:#0A0A0A; }
  .custom-marker {
    width: 32px; height: 32px; border-radius: 16px;
    background:#3B82F6; border:3px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.55);
    cursor: pointer; display:flex; align-items:center; justify-content:center;
    color: #fff; font: 700 12px -apple-system, system-ui, sans-serif;
  }
  .user-dot {
    width: 16px; height: 16px; border-radius: 8px;
    background:#1A73E8; border:3px solid #fff; box-shadow: 0 0 8px rgba(0,0,0,0.45);
    position: relative;
  }
  .user-dot.has-heading::after {
    content: '';
    position: absolute;
    top: -14px;
    left: 50%;
    transform: translateX(-50%) rotate(0deg);
    width: 0; height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-bottom: 14px solid #1A73E8;
    filter: drop-shadow(0 0 2px rgba(255,255,255,0.95));
    transition: transform 400ms ease-out;
  }
  .mapboxgl-ctrl-logo, .mapboxgl-ctrl-attrib { display:none !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
  mapboxgl.accessToken = ${JSON.stringify(token)};
  var map = new mapboxgl.Map({
    container: 'map',
    style: ${JSON.stringify(style)},
    center: ${JSON.stringify(center)},
    zoom: ${zoom},
    pitch: 0,
    bearing: 0,
    attributionControl: false,
    logoPosition: 'bottom-left',
  });

  var markers = {};
  var userMarker = null;

  function post(msg) {
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else window.parent && window.parent.postMessage(s, '*');
  }

  // Apply our basemap config + hide business/POI labels (they can look outdated).
  function hidePoiLayers() {
    // New Standard style: config-driven. Apply the chosen day/night light preset
    // (defaults to night to match the dark UI) and hide POIs via the config flag.
    try { map.setConfigProperty('basemap', 'lightPreset', window.__lightPreset || 'night'); } catch (e) {}
    try { map.setConfigProperty('basemap', 'showPointOfInterestLabels', false); } catch (e) {}
    // Classic styles (streets/satellite/dark/outdoors): hide 'poi' layers.
    try {
      var ls = (map.getStyle() && map.getStyle().layers) || [];
      for (var i = 0; i < ls.length; i++) {
        var id = (ls[i].id || '').toLowerCase();
        if (id.indexOf('poi') !== -1) {
          try { map.setLayoutProperty(ls[i].id, 'visibility', 'none'); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  map.on('load', function () {
    post({ type: 'ready' });
    ensureRouteLayer();
    hidePoiLayers();
  });
  // Re-apply once each time a NEW style finishes loading. (Do NOT use 'styledata'
  // here — it fires continuously and hidePoiLayers calls setConfigProperty, which
  // re-fires styledata, creating a feedback loop that thrashes the map.)
  map.on('style.load', hidePoiLayers);
  map.on('click', function (e) {
    post({ type: 'click', lng: e.lngLat.lng, lat: e.lngLat.lat });
  });
  // Long-press (touch) / right-click (web) → emit a longpress event.
  map.on('contextmenu', function (e) {
    post({ type: 'longpress', lng: e.lngLat.lng, lat: e.lngLat.lat });
  });
  // User-initiated camera interactions → tell RN to exit follow mode.
  function emitUserPan(e) {
    if (!e || !e.originalEvent) return; // ignore programmatic moves
    post({ type: 'userPan' });
  }
  map.on('dragstart', emitUserPan);
  map.on('zoomstart', emitUserPan);
  map.on('rotatestart', emitUserPan);
  map.on('pitchstart', emitUserPan);
  map.on('moveend', function () {
    var c = map.getCenter();
    post({
      type: 'moveEnd',
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    });
  });

  function emptyFC() { return { type:'FeatureCollection', features: [] }; }

  function ensureRouteLayer() {
    if (map.getSource('route')) return;
    // Alternate routes sit BENEATH the active route (added first).
    map.addSource('alt-routes', { type:'geojson', data: emptyFC() });
    map.addLayer({
      id:'alt-routes-casing', type:'line', source:'alt-routes',
      layout:{ 'line-join':'round', 'line-cap':'round' },
      paint:{ 'line-color':'#0B141A', 'line-width':8, 'line-opacity':0.6 }
    });
    map.addLayer({
      id:'alt-routes-line', type:'line', source:'alt-routes',
      layout:{ 'line-join':'round', 'line-cap':'round' },
      paint:{ 'line-color':'#8696A0', 'line-width':5, 'line-opacity':0.9 }
    });
    // Active route, drawn on top.
    map.addSource('route', { type:'geojson', data:{ type:'Feature', geometry:{ type:'LineString', coordinates:[] }, properties:{} } });
    map.addLayer({
      id:'route-casing', type:'line', source:'route',
      layout:{ 'line-join':'round', 'line-cap':'round' },
      paint:{ 'line-color':'#0A2540', 'line-width':['interpolate',['linear'],['zoom'],10,7,16,13], 'line-opacity':0.85 }
    });
    map.addLayer({
      id:'route-line', type:'line', source:'route',
      layout:{ 'line-join':'round', 'line-cap':'round' },
      paint:{ 'line-color':'#1A73E8', 'line-width':['interpolate',['linear'],['zoom'],10,4,16,9], 'line-opacity':1 }
    });
  }

  function setStyle(url) {
    map.setStyle(url);
    map.once('styledata', function () {
      ensureRouteLayer();
      hidePoiLayers();
      // Re-apply traffic / 3d if needed
      if (window.__trafficOn) addTraffic();
      if (window.__buildingsOn) add3D();
    });
  }

  function clearMarkers() {
    Object.keys(markers).forEach(function (id) {
      markers[id].remove();
      delete markers[id];
    });
  }

  function setMarkers(list) {
    clearMarkers();
    (list || []).forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'custom-marker';
      if (m.color) el.style.background = m.color;
      if (m.label) el.textContent = m.label;
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        post({ type:'markerClick', id: m.id });
      });
      var marker = new mapboxgl.Marker(el).setLngLat([m.longitude, m.latitude]).addTo(map);
      if (m.title) {
        marker.setPopup(new mapboxgl.Popup({ offset: 22, closeButton:false }).setText(m.title));
      }
      markers[m.id] = marker;
    });
  }

  function setRoute(geometry) {
    ensureRouteLayer();
    var data = geometry
      ? { type:'Feature', geometry: geometry, properties:{} }
      : { type:'Feature', geometry:{ type:'LineString', coordinates:[] }, properties:{} };
    var src = map.getSource('route');
    if (src) src.setData(data);
  }

  function setAltRoutes(geometries) {
    ensureRouteLayer();
    var feats = (geometries || []).map(function (g, i) {
      return { type:'Feature', geometry: g, properties:{ index: i } };
    });
    var src = map.getSource('alt-routes');
    if (src) src.setData({ type:'FeatureCollection', features: feats });
  }

  function flyTo(lng, lat, zoom) {
    map.flyTo({ center:[lng,lat], zoom: zoom != null ? zoom : map.getZoom(), essential: true });
  }
  // Lightweight linear glide used for continuous "follow" tracking. Much cheaper
  // and smoother than flyTo when fired on every GPS fix.
  function panTo(lng, lat) {
    map.easeTo({ center:[lng,lat], duration: 700, easing: function (t) { return t; } });
  }
  function setUserLocation(lng, lat, accuracyM, heading) {
    if (!userMarker) {
      var el = document.createElement('div');
      el.className = 'user-dot';
      userMarker = new mapboxgl.Marker({ element: el, anchor: 'center', rotationAlignment: 'map' }).setLngLat([lng,lat]).addTo(map);
    } else {
      userMarker.setLngLat([lng, lat]);
    }
    // Heading arrow — rotate the WHOLE marker via Mapbox (never touch the
    // element's transform directly: that's what positions it on the ground).
    try {
      var dotEl = userMarker.getElement();
      if (heading != null && !isNaN(heading)) {
        dotEl.classList.add('has-heading');
        userMarker.setRotation(heading);
      } else {
        dotEl.classList.remove('has-heading');
        userMarker.setRotation(0);
      }
    } catch (e) {}

    // Accuracy circle (Mapbox native source — true geographic meters)
    var SRC = 'user-accuracy-src', LYR = 'user-accuracy-lyr';
    var feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { accuracy: (accuracyM && accuracyM > 0) ? accuracyM : 0 },
    };
    if (!map.getSource(SRC)) {
      try {
        map.addSource(SRC, { type: 'geojson', data: feature });
        map.addLayer({
          id: LYR, type: 'circle', source: SRC,
          paint: {
            // radius in pixels, converted from meters using the current zoom.
            // Mapbox doesn't natively render meters-radius circles cheaply; we
            // approximate with an expression that scales with zoom.
            'circle-radius': [
              'interpolate', ['exponential', 2], ['zoom'],
              0, ['/', ['get', 'accuracy'], 40075000 * 256],
              22, ['/', ['*', ['get', 'accuracy'], Math.pow(2, 22)], 40075000],
            ],
            'circle-color': '#1A73E8',
            'circle-opacity': 0.15,
            'circle-stroke-color': '#1A73E8',
            'circle-stroke-width': 1,
            'circle-stroke-opacity': 0.35,
          },
        }, 'user-anchor-noop');
      } catch (e) {
        // The "before" layer doesn't exist; retry without it
        try { map.addLayer({
          id: LYR, type: 'circle', source: SRC,
          paint: {
            'circle-radius': [
              'interpolate', ['exponential', 2], ['zoom'],
              0, 0,
              22, ['/', ['*', ['get', 'accuracy'], Math.pow(2, 22)], 40075000],
            ],
            'circle-color': '#1A73E8',
            'circle-opacity': 0.15,
            'circle-stroke-color': '#1A73E8',
            'circle-stroke-width': 1,
            'circle-stroke-opacity': 0.35,
          },
        }); } catch (e2) {}
      }
    } else {
      try { map.getSource(SRC).setData(feature); } catch (e) {}
    }
  }
  function setPitch(p) { map.easeTo({ pitch: p, duration: 400 }); }
  function setBearing(b) { map.easeTo({ bearing: b, duration: 400 }); }
  function resetNorth() { map.easeTo({ bearing: 0, pitch: 0, duration: 600 }); }

  function addTraffic() {
    if (map.getSource('mapbox-traffic')) return;
    try {
      map.addSource('mapbox-traffic', { type:'vector', url:'mapbox://mapbox.mapbox-traffic-v1' });
      map.addLayer({
        id:'traffic-layer', type:'line', source:'mapbox-traffic', 'source-layer':'traffic',
        layout:{ 'line-join':'round', 'line-cap':'round' },
        paint:{
          'line-width': 2.5,
          'line-color': [
            'match', ['get','congestion'],
            'low', '#22C55E',
            'moderate', '#EAB308',
            'heavy', '#F97316',
            'severe', '#EF4444',
            '#71717A'
          ]
        }
      });
    } catch(e) {}
  }
  function removeTraffic() {
    if (map.getLayer('traffic-layer')) map.removeLayer('traffic-layer');
    if (map.getSource('mapbox-traffic')) map.removeSource('mapbox-traffic');
  }
  function setTraffic(on) {
    window.__trafficOn = !!on;
    if (on) addTraffic(); else removeTraffic();
  }

  function add3D() {
    if (map.getLayer('3d-buildings')) return;
    var layers = map.getStyle().layers || [];
    var labelLayerId;
    for (var i=0;i<layers.length;i++) {
      if (layers[i].type === 'symbol' && layers[i].layout && layers[i].layout['text-field']) {
        labelLayerId = layers[i].id; break;
      }
    }
    try {
      map.addLayer({
        id:'3d-buildings',
        source:'composite',
        'source-layer':'building',
        filter:['==','extrude','true'],
        type:'fill-extrusion',
        minzoom:13,
        paint:{
          'fill-extrusion-color':'#3B82F6',
          'fill-extrusion-height':['interpolate',['linear'],['zoom'],13,0,15.05,['get','height']],
          'fill-extrusion-base':['interpolate',['linear'],['zoom'],13,0,15.05,['get','min_height']],
          'fill-extrusion-opacity':0.65
        }
      }, labelLayerId);
    } catch(e) {}
  }
  function remove3D() {
    if (map.getLayer('3d-buildings')) map.removeLayer('3d-buildings');
  }
  function set3DBuildings(on) {
    window.__buildingsOn = !!on;
    if (on) { add3D(); map.easeTo({ pitch: Math.max(map.getPitch(), 45), duration: 400 }); }
    else { remove3D(); }
  }

  function fitBounds(coords, padding) {
    if (!coords || coords.length < 2) return;
    var bounds = coords.reduce(function (b, c) { return b.extend(c); }, new mapboxgl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: padding || 80, duration: 600 });
  }

  window.__handle = function (raw) {
    try {
      var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      switch (msg.cmd) {
        case 'setStyle': setStyle(msg.url); break;
        case 'setMarkers': setMarkers(msg.markers); break;
        case 'setRoute': setRoute(msg.geometry); break;
        case 'setAltRoutes': setAltRoutes(msg.geometries); break;
        case 'flyTo': flyTo(msg.lng, msg.lat, msg.zoom); break;
        case 'panTo': panTo(msg.lng, msg.lat); break;
        case 'setUserLocation': setUserLocation(msg.lng, msg.lat, msg.accuracy, msg.heading); break;
        case 'setPitch': setPitch(msg.value); break;
        case 'setBearing': setBearing(msg.value); break;
        case 'resetNorth': resetNorth(); break;
        case 'setTraffic': setTraffic(msg.on); break;
        case 'set3DBuildings': set3DBuildings(msg.on); break;
        case 'setLightPreset': window.__lightPreset = msg.preset; try { map.setConfigProperty('basemap', 'lightPreset', msg.preset); } catch (e) {} break;
        case 'fitBounds': fitBounds(msg.coords, msg.padding); break;
      }
    } catch (e) {}
  };
  window.addEventListener('message', function (e) { window.__handle(e.data); });
</script>
</body>
</html>`;
}

export const MapboxWebView = forwardRef<MapboxWebViewHandle, Props>(
  ({ initialCenter, initialZoom, initialStyle, onEvent }, ref) => {
    const webRef = useRef<WebView>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    const html = useMemo(
      () => buildHtml(MAPBOX_TOKEN, initialCenter, initialZoom, initialStyle),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    const send = (cmd: object) => {
      const payload = JSON.stringify(cmd);
      if (Platform.OS === "web") {
        iframeRef.current?.contentWindow?.postMessage(payload, "*");
      } else {
        webRef.current?.injectJavaScript(
          `window.__handle && window.__handle(${JSON.stringify(payload)}); true;`,
        );
      }
    };

    useImperativeHandle(ref, () => ({
      setStyle: (url) => send({ cmd: "setStyle", url }),
      setMarkers: (markers) => send({ cmd: "setMarkers", markers }),
      setRoute: (geometry) => send({ cmd: "setRoute", geometry }),
      setAltRoutes: (geometries) => send({ cmd: "setAltRoutes", geometries }),
      flyTo: (lng, lat, zoom) => send({ cmd: "flyTo", lng, lat, zoom }),
      panTo: (lng, lat) => send({ cmd: "panTo", lng, lat }),
      setUserLocation: (lng, lat, accuracy, heading) => send({ cmd: "setUserLocation", lng, lat, accuracy, heading }),
      setPitch: (value) => send({ cmd: "setPitch", value }),
      setBearing: (value) => send({ cmd: "setBearing", value }),
      resetNorth: () => send({ cmd: "resetNorth" }),
      setTraffic: (on) => send({ cmd: "setTraffic", on }),
      set3DBuildings: (on) => send({ cmd: "set3DBuildings", on }),
      setLightPreset: (preset) => send({ cmd: "setLightPreset", preset }),
      fitBounds: (coords, padding) => send({ cmd: "fitBounds", coords, padding }),
    }));

    if (Platform.OS === "web") {
      return (
        <View style={styles.container} testID="mapbox-view">
          <iframe
            ref={(el) => {
              iframeRef.current = el;
            }}
            srcDoc={html}
            style={{ border: "none", width: "100%", height: "100%", background: "#0A0A0A" }}
          />
          <WebMessageBridge onEvent={onEvent} />
        </View>
      );
    }
    return (
      <View style={styles.container} testID="mapbox-view">
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ html }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          onMessage={(e) => {
            try {
              const data = JSON.parse(e.nativeEvent.data) as MapboxEvent;
              onEvent?.(data);
            } catch {}
          }}
        />
      </View>
    );
  },
);
MapboxWebView.displayName = "MapboxWebView";

const WebMessageBridge: React.FC<{ onEvent?: (e: MapboxEvent) => void }> = ({ onEvent }) => {
  React.useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const handler = (e: MessageEvent) => {
      try {
        const data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
        if (data && typeof data === "object" && "type" in data) {
          onEvent?.(data as MapboxEvent);
        }
      } catch {}
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onEvent]);
  return null;
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0A0A0A" },
  webview: { flex: 1, backgroundColor: "#0A0A0A" },
});

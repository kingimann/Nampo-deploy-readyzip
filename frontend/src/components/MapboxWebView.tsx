import React, { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet, View, Text, Platform } from "react-native";
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
  | { type: "hazardClick"; id: string }
  | { type: "userPan" }
  | { type: "moveEnd"; center: [number, number]; zoom: number; bearing: number; pitch: number };

export type MapboxWebViewHandle = {
  setStyle: (styleUrl: string) => void;
  setMarkers: (markers: MarkerInput[]) => void;
  setPlaceMarkers: (markers: MarkerInput[]) => void;
  setHazardMarkers: (markers: MarkerInput[]) => void;
  setRoute: (geometry: RouteGeometry | null) => void;
  setAltRoutes: (geometries: RouteGeometry[]) => void;
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  panTo: (lng: number, lat: number) => void;
  followCamera: (lng: number, lat: number, zoom?: number, bearing?: number, pitch?: number) => void;
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
  /* Stop iOS Safari from hijacking a long-press with its text-callout/selection
     so our own long-press-to-drop-a-pin gesture can fire. */
  #map, .mapboxgl-canvas { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
  .custom-marker {
    width: 32px; height: 32px; border-radius: 16px;
    background:#3B82F6; border:3px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.55);
    cursor: pointer; display:flex; align-items:center; justify-content:center;
    color: #fff; font: 700 12px -apple-system, system-ui, sans-serif;
  }
  .hazard-marker {
    width: 32px; height: 32px; border-radius: 9px;
    background:#fff; border:2px solid #F59E0B; box-shadow: 0 2px 9px rgba(0,0,0,0.5);
    display:flex; align-items:center; justify-content:center;
    font-size: 17px; cursor: pointer;
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
    // ── Performance: make zooming/panning smoother in the WebView. ──
    fadeDuration: 0,          // no label cross-fade work on every zoom frame
    renderWorldCopies: false, // don't render duplicate worlds (fewer tiles)
    antialias: false,         // cheaper rasterization
  });
  // Cap zoom-in so the camera never grinds past street level (heavy + pointless).
  map.setMaxZoom(18);

  var markers = {};
  var userMarker = null;
  var lpFiredAt = 0;  // timestamp of the last long-press, to swallow the trailing tap

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
    // A long-press ends with a finger-lift that Mapbox reports as a tap; ignore
    // it so the pin we just dropped isn't immediately dismissed.
    if (Date.now() - lpFiredAt < 700) return;
    // If the click landed on a place dot, the layer handler deals with it —
    // don't also emit a generic map click (which would drop a pin).
    try {
      if (map.getLayer('places-circle')) {
        var hits = map.queryRenderedFeatures(e.point, { layers: ['places-circle'] });
        if (hits && hits.length) return;
      }
    } catch (err) {}
    post({ type: 'click', lng: e.lngLat.lng, lat: e.lngLat.lat });
  });
  // Long-press (web) / right-click → emit a longpress event. Mapbox fires
  // 'contextmenu' on desktop right-click and some touch devices, but iOS
  // Safari does NOT, so a manual touch detector is added below.
  map.on('contextmenu', function (e) {
    post({ type: 'longpress', lng: e.lngLat.lng, lat: e.lngLat.lat });
  });
  // Robust touch long-press: hold a single finger still for ~450ms anywhere on
  // the map → drop a pin. Cancels if the finger moves (a pan) or lifts early.
  (function () {
    var lpTimer = null, startXY = null, fired = false;
    var HOLD_MS = 450, MOVE_CANCEL = 12;
    var el = map.getCanvasContainer();
    function clearLP() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
      startXY = null;
    }
    el.addEventListener('touchstart', function (ev) {
      if (!ev.touches || ev.touches.length !== 1) { clearLP(); return; }
      var t = ev.touches[0];
      var rect = el.getBoundingClientRect();
      var px = t.clientX - rect.left, py = t.clientY - rect.top;
      startXY = { x: t.clientX, y: t.clientY };
      fired = false;
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = setTimeout(function () {
        fired = true;
        lpFiredAt = Date.now();
        try {
          var ll = map.unproject([px, py]);
          post({ type: 'longpress', lng: ll.lng, lat: ll.lat });
        } catch (err) {}
        clearLP();
      }, HOLD_MS);
    }, { passive: true });
    el.addEventListener('touchmove', function (ev) {
      if (!startXY || !ev.touches || !ev.touches.length) return;
      var t = ev.touches[0];
      if (Math.abs(t.clientX - startXY.x) > MOVE_CANCEL ||
          Math.abs(t.clientY - startXY.y) > MOVE_CANCEL) clearLP();
    }, { passive: true });
    el.addEventListener('touchend', clearLP, { passive: true });
    el.addEventListener('touchcancel', clearLP, { passive: true });
  })();
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
      // Re-add the GPU place layer (a style switch drops all custom sources).
      if (window.__placesData) { ensurePlacesLayer(); var s = map.getSource('places-src'); if (s) s.setData(window.__placesData); }
      // Re-push the active route + alternates — the source was wiped by setStyle,
      // so without this the route line vanishes when the style changes mid-trip.
      if (window.__route) setRoute(window.__route);
      if (window.__altRoutes && window.__altRoutes.length) setAltRoutes(window.__altRoutes);
      // Re-create the user accuracy circle (its source was wiped with the style).
      if (window.__lastUserLoc) {
        var u = window.__lastUserLoc;
        setUserLocation(u.lng, u.lat, u.accuracyM, u.heading);
      }
      // Re-apply traffic / 3d if needed (source-aware so it works on Standard too)
      if (window.__trafficOn) addTraffic();
      if (window.__buildingsOn) apply3D(true);
    });
  }

  function clearMarkers() {
    Object.keys(markers).forEach(function (id) {
      markers[id].remove();
      delete markers[id];
    });
  }

  // ── GPU-rendered place dots ──────────────────────────────────────────────
  // Saved places can number in the dozens/hundreds. DOM markers reposition via
  // JS on EVERY render frame during pan/zoom (the classic Mapbox perf killer),
  // so render them as a single GPU circle layer instead. Constant cost no
  // matter how many places there are.
  function ensurePlacesLayer() {
    if (map.getSource('places-src')) return;
    try {
      map.addSource('places-src', { type:'geojson', data: emptyFC() });
      map.addLayer({
        id:'places-circle', type:'circle', source:'places-src',
        paint:{
          'circle-radius':['interpolate',['linear'],['zoom'],8,5,16,9],
          'circle-color':['get','color'],
          'circle-stroke-color':'#ffffff',
          'circle-stroke-width':2.5,
          'circle-stroke-opacity':1,
        }
      });
      map.on('click', 'places-circle', function (e) {
        var f = e.features && e.features[0];
        if (f && f.properties) post({ type:'markerClick', id: f.properties.id });
      });
      map.on('mouseenter', 'places-circle', function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'places-circle', function () { map.getCanvas().style.cursor = ''; });
    } catch (e) {}
  }
  function setPlaceMarkers(list) {
    ensurePlacesLayer();
    var feats = (list || []).map(function (m) {
      return {
        type:'Feature',
        geometry:{ type:'Point', coordinates:[m.longitude, m.latitude] },
        properties:{ id: m.id, color: m.color || '#3B82F6', title: m.title || '' },
      };
    });
    var fc = { type:'FeatureCollection', features: feats };
    window.__placesData = fc; // remembered so it survives a style switch
    var src = map.getSource('places-src');
    if (src) src.setData(fc);
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

  // ── Crowd-sourced hazard markers (Waze-style) ──
  var hazardMarkers = {};
  function clearHazards() {
    Object.keys(hazardMarkers).forEach(function (id) { hazardMarkers[id].remove(); delete hazardMarkers[id]; });
  }
  function setHazardMarkers(list) {
    clearHazards();
    (list || []).forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'hazard-marker';
      el.textContent = m.label || '⚠️';
      el.addEventListener('click', function (ev) { ev.stopPropagation(); post({ type:'hazardClick', id: m.id }); });
      var marker = new mapboxgl.Marker(el).setLngLat([m.longitude, m.latitude]).addTo(map);
      if (m.title) marker.setPopup(new mapboxgl.Popup({ offset: 22, closeButton:false }).setText(m.title));
      hazardMarkers[m.id] = marker;
    });
  }

  function setRoute(geometry) {
    window.__route = geometry || null;   // remembered so the line survives a style switch
    ensureRouteLayer();
    var data = geometry
      ? { type:'Feature', geometry: geometry, properties:{} }
      : { type:'Feature', geometry:{ type:'LineString', coordinates:[] }, properties:{} };
    var src = map.getSource('route');
    if (src) src.setData(data);
  }

  function setAltRoutes(geometries) {
    window.__altRoutes = geometries || [];   // remembered across a style switch
    ensureRouteLayer();
    var feats = (geometries || []).map(function (g, i) {
      return { type:'Feature', geometry: g, properties:{ index: i } };
    });
    var src = map.getSource('alt-routes');
    if (src) src.setData({ type:'FeatureCollection', features: feats });
  }

  function flyTo(lng, lat, zoom) {
    var z = zoom != null ? zoom : map.getZoom();
    var curZoom = map.getZoom();
    var from = map.getCenter();
    var degDist = Math.abs(from.lng - lng) + Math.abs(from.lat - lat);
    // Opening from the far-out world view (or a huge geographic jump): snap
    // instantly. A long flyTo from z1.7 -> z16 grinds through every zoom level
    // and renders hundreds of intermediate tiles — that's the "auto zoom is
    // laggy" feeling. jumpTo is instant and renders only the destination.
    if (curZoom < 6 || degDist > 12) {
      map.jumpTo({ center:[lng,lat], zoom: z });
      return;
    }
    if (degDist > 0.5) {
      // Far-ish jump (e.g. a search result a city away): real flyTo, but capped
      // so it can't turn into a multi-second tile-rendering slog.
      map.flyTo({ center:[lng,lat], zoom: z, essential: true, speed: 2.0, maxDuration: 1600 });
    } else {
      // Nearby recenter / zoom change: a short ease is far snappier than flyTo's
      // zoom-out-then-in arc.
      map.easeTo({ center:[lng,lat], zoom: z, duration: 600, essential: true });
    }
  }
  // Lightweight linear glide used for continuous "follow" tracking. Much cheaper
  // and smoother than flyTo when fired on every GPS fix.
  function panTo(lng, lat) {
    // essential:true so follow-mode tracking still glides when the OS/browser
    // has "prefers reduced motion" set (otherwise the camera silently stops).
    map.easeTo({ center:[lng,lat], duration: 700, essential: true, easing: function (t) { return t; } });
  }
  // Combined navigation "follow camera": center + zoom + bearing (course-up) +
  // pitch (3D forward view) in a single smooth ease, so you can see the streets
  // and the upcoming turn. Fired on each GPS fix during turn-by-turn.
  function followCamera(lng, lat, zoom, bearing, pitch) {
    var opts = { center:[lng,lat], duration: 900, easing: function (t) { return t; } };
    if (zoom != null) opts.zoom = zoom;
    if (bearing != null) opts.bearing = bearing;
    if (pitch != null) opts.pitch = pitch;
    map.easeTo(opts);
  }
  function setUserLocation(lng, lat, accuracyM, heading) {
    window.__lastUserLoc = { lng: lng, lat: lat, accuracyM: accuracyM, heading: heading }; // replay across a style switch
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
        });
      } catch (e) {
        // Defensive fallback if the primary add fails for any reason.
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
  // Classic styles expose a 'composite' vector source (custom fill-extrusion);
  // the Standard style has no 'composite' source and instead exposes built-in 3D
  // objects via a config property. Pick the right mechanism so 3D actually works
  // on Standard instead of silently no-opping while the toggle shows "On".
  function apply3D(on) {
    if (map.getSource('composite')) {
      if (on) add3D(); else remove3D();
    } else {
      try { map.setConfigProperty('basemap', 'show3dObjects', !!on); } catch (e) {}
    }
  }
  function set3DBuildings(on) {
    window.__buildingsOn = !!on;
    apply3D(!!on);
    if (on) map.easeTo({ pitch: Math.max(map.getPitch(), 45), duration: 400 });
  }

  function fitBounds(coords, padding) {
    if (!coords || coords.length < 2) return;
    var bounds = coords.reduce(function (b, c) { return b.extend(c); }, new mapboxgl.LngLatBounds(coords[0], coords[0]));
    // Degenerate bounds (all points identical, e.g. origin == destination) would
    // zoom to maxZoom — recenter at a sensible zoom instead.
    if (bounds.getNorth() - bounds.getSouth() < 1e-6 && bounds.getEast() - bounds.getWest() < 1e-6) {
      map.easeTo({ center: coords[0], zoom: 15, duration: 600 });
      return;
    }
    map.fitBounds(bounds, { padding: padding || 80, duration: 600 });
  }

  window.__handle = function (raw) {
    try {
      var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      switch (msg.cmd) {
        case 'setStyle': setStyle(msg.url); break;
        case 'setMarkers': setMarkers(msg.markers); break;
        case 'setPlaceMarkers': setPlaceMarkers(msg.markers); break;
        case 'setHazardMarkers': setHazardMarkers(msg.markers); break;
        case 'setRoute': setRoute(msg.geometry); break;
        case 'setAltRoutes': setAltRoutes(msg.geometries); break;
        case 'flyTo': flyTo(msg.lng, msg.lat, msg.zoom); break;
        case 'panTo': panTo(msg.lng, msg.lat); break;
        case 'followCamera': followCamera(msg.lng, msg.lat, msg.zoom, msg.bearing, msg.pitch); break;
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
      setPlaceMarkers: (markers) => send({ cmd: "setPlaceMarkers", markers }),
      setHazardMarkers: (markers) => send({ cmd: "setHazardMarkers", markers }),
      setRoute: (geometry) => send({ cmd: "setRoute", geometry }),
      setAltRoutes: (geometries) => send({ cmd: "setAltRoutes", geometries }),
      flyTo: (lng, lat, zoom) => send({ cmd: "flyTo", lng, lat, zoom }),
      panTo: (lng, lat) => send({ cmd: "panTo", lng, lat }),
      followCamera: (lng, lat, zoom, bearing, pitch) => send({ cmd: "followCamera", lng, lat, zoom, bearing, pitch }),
      setUserLocation: (lng, lat, accuracy, heading) => send({ cmd: "setUserLocation", lng, lat, accuracy, heading }),
      setPitch: (value) => send({ cmd: "setPitch", value }),
      setBearing: (value) => send({ cmd: "setBearing", value }),
      resetNorth: () => send({ cmd: "resetNorth" }),
      setTraffic: (on) => send({ cmd: "setTraffic", on }),
      set3DBuildings: (on) => send({ cmd: "set3DBuildings", on }),
      setLightPreset: (preset) => send({ cmd: "setLightPreset", preset }),
      fitBounds: (coords, padding) => send({ cmd: "fitBounds", coords, padding }),
    }));

    // No Mapbox token → mapbox-gl can't initialize and the map renders as a
    // blank/black box. Fail loudly with an actionable message instead.
    if (!MAPBOX_TOKEN) {
      return (
        <View style={[styles.container, styles.fallback]} testID="mapbox-view">
          <Text style={styles.fallbackTitle}>Map unavailable</Text>
          <Text style={styles.fallbackText}>
            Set EXPO_PUBLIC_MAPBOX_TOKEN in your environment and rebuild the app to enable maps.
          </Text>
        </View>
      );
    }

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
  fallback: { alignItems: "center", justifyContent: "center", padding: 24 },
  fallbackTitle: { color: "#E5E7EB", fontSize: 16, fontWeight: "800", marginBottom: 8 },
  fallbackText: { color: "#9AA3AE", fontSize: 13, lineHeight: 19, textAlign: "center", maxWidth: 300 },
});

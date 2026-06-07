import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, RefreshControl, Image, Alert, Linking, Platform, Modal, Pressable, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import * as Location from "expo-location";
import { safeBack } from "@/src/utils/nav";
import { reverseGeocode } from "@/src/api/mapbox";
import { pickDocumentBase64 } from "@/src/utils/thumbnail";
import CameraCapture from "@/src/components/CameraCapture";
import { api, RoadsideRequest, RoadsideService, RoadsideParty, RoadsideQuote, RoadsideEligibility, RoadsideVerificationStatus, RoadsideCheckResult } from "@/src/api/client";
import { useConfirm } from "@/src/context/ConfirmContext";
import { theme } from "@/src/theme";

const SERVICE_META: Record<RoadsideService, { label: string; icon: any; desc: string }> = {
  tow:     { label: "Tow",                icon: "car-sport",        desc: "Vehicle needs towing to a shop or home" },
  lockout: { label: "Lockout",            icon: "key",              desc: "Locked out — keys inside the car" },
  battery: { label: "Battery boost",      icon: "battery-charging", desc: "Dead battery — needs a jump start" },
  tire:    { label: "Tire change / flat", icon: "disc",             desc: "Flat tire — swap to spare or repair" },
  gas:     { label: "Gas delivery",       icon: "water",            desc: "Out of fuel — gas brought to you" },
};
const SERVICE_ORDER: RoadsideService[] = ["tow", "lockout", "battery", "tire", "gas"];
const FUEL_TYPES: { k: string; label: string }[] = [
  { k: "regular", label: "Regular" },
  { k: "midgrade", label: "Mid-grade" },
  { k: "premium", label: "Premium" },
];
const GAS_AMOUNTS = ["$10", "$20", "$30", "$40", "$50"];
const AUTO_DECLINE_SECS = 120;   // a helper has 2 min to accept/decline a call
const NEARBY_POLL_MS = 12000;    // refresh nearby calls so taken ones drop off

const STATUS_LABEL = (r: RoadsideRequest) =>
  r.status === "open" ? { label: "Searching for help", color: theme.warning }
  : r.status === "accepted" ? (r.arrived ? { label: "Helper on location", color: theme.success } : r.en_route ? { label: "Helper en route", color: theme.primary } : { label: "Helper assigned", color: theme.primary })
  : r.status === "completed" ? { label: "Completed", color: theme.success }
  : { label: "Cancelled", color: theme.textMuted };

const NOW_YEAR = new Date().getFullYear() + 1;
const YEARS = Array.from({ length: NOW_YEAR - 1980 + 1 }, (_, i) => String(NOW_YEAR - i));
const MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Fiat", "Ford",
  "GMC", "Genesis", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus",
  "Lincoln", "Mazda", "Mercedes-Benz", "Mini", "Mitsubishi", "Nissan", "Polestar", "Porsche", "Ram",
  "Rivian", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo", "Other",
];

function Dropdown({ value, placeholder, options, onChange, testID }: {
  value: string; placeholder: string; options: string[]; onChange: (v: string) => void; testID?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity style={styles.dropdown} onPress={() => setOpen(true)} testID={testID}>
        <Text style={[styles.dropdownText, !value && { color: theme.textMuted }]} numberOfLines={1}>{value || placeholder}</Text>
        <Ionicons name="chevron-down" size={16} color={theme.textMuted} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.ddBackdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.ddSheet}>
            <ScrollView>
              {options.map((o) => (
                <TouchableOpacity key={o} style={styles.ddRow} onPress={() => { onChange(o); setOpen(false); }} testID={`${testID}-${o}`}>
                  <Text style={[styles.ddRowText, value === o && { color: theme.primary, fontWeight: "800" }]}>{o}</Text>
                  {value === o && <Ionicons name="checkmark" size={18} color={theme.primary} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function Photos({ uris, onRemove }: { uris: string[]; onRemove?: (i: number) => void }) {
  if (!uris || uris.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }} contentContainerStyle={{ gap: 8 }}>
      {uris.map((u, i) => (
        <View key={i} style={styles.photoWrap}>
          <Image source={{ uri: u }} style={styles.photo} />
          {onRemove && (
            <TouchableOpacity style={styles.photoX} onPress={() => onRemove(i)}>
              <Ionicons name="close" size={13} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

export default function RoadsideScreen() {
  const router = useRouter();
  const confirm = useConfirm();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<"request" | "nearby" | "helping" | "history">("request");
  const [active, setActive] = useState<RoadsideRequest | null>(null);
  const [helping, setHelping] = useState<RoadsideRequest | null>(null);
  const [nearby, setNearby] = useState<RoadsideRequest[]>([]);
  const [callDetail, setCallDetail] = useState<RoadsideRequest | null>(null);  // open accept/decline screen
  const [countdown, setCountdown] = useState(AUTO_DECLINE_SECS);               // seconds left to respond
  const [declined, setDeclined] = useState<Set<string>>(new Set());            // hidden nearby calls
  const [hist, setHist] = useState<RoadsideRequest[]>([]);
  const [payMethod, setPayMethod] = useState<"wallet" | "cash">("wallet");
  const [reviewing, setReviewing] = useState<RoadsideRequest | null>(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewText, setReviewText] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkRes, setCheckRes] = useState<RoadsideCheckResult | null>(null);
  const [quote, setQuote] = useState<RoadsideQuote | null>(null);
  const [elig, setElig] = useState<RoadsideEligibility | null>(null);
  const [verif, setVerif] = useState<RoadsideVerificationStatus | null>(null);
  const [insuranceDoc, setInsuranceDoc] = useState<string | null>(null);
  const [ownershipDoc, setOwnershipDoc] = useState<string | null>(null);
  const [submittingVerif, setSubmittingVerif] = useState(false);
  const [verifErr, setVerifErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [noLocation, setNoLocation] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // New-request form
  const [service, setService] = useState<RoadsideService | null>(null);
  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [placeName, setPlaceName] = useState("");
  const [destName, setDestName] = useState("");
  const [fuelType, setFuelType] = useState("");
  const [fuelAmount, setFuelAmount] = useState("");
  const [vehicleOpen, setVehicleOpen] = useState(false);
  const [vYear, setVYear] = useState("");
  const [vMake, setVMake] = useState("");
  const [vModel, setVModel] = useState("");
  const [vColor, setVColor] = useState("");
  const [vPlate, setVPlate] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const detect = useCallback(async (prompt: boolean): Promise<{ coords: [number, number]; name: string } | null> => {
    setLocating(true);
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!prompt) return null;
        const r = await Location.requestForegroundPermissionsAsync();
        status = r.status;
      }
      if (status !== "granted") return null;
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const c: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      let name = "";
      // Mapbox reverse geocode → exact street address (works on web + native).
      try {
        const f = await reverseGeocode(c[0], c[1]);
        if (f) name = f.full_address || f.name || "";
      } catch {}
      // Native fallback if Mapbox is unavailable.
      if (!name && Platform.OS !== "web") {
        try {
          const places = await Location.reverseGeocodeAsync({ latitude: c[1], longitude: c[0] });
          const p = places?.[0];
          if (p) name = [p.name, p.street, p.city, p.region, p.postalCode].filter(Boolean).join(", ");
        } catch {}
      }
      return { coords: c, name };
    } catch {
      return null;
    } finally {
      setLocating(false);
    }
  }, []);

  const loadNearby = useCallback(async (c: [number, number] | null) => {
    if (!c) { setNearby([]); setNoLocation(true); return; }
    setNoLocation(false);
    try { setNearby(await api.roadsideNearby({ lng: c[0], lat: c[1], radius_km: 80 })); } catch { setNearby([]); }
  }, []);

  const load = useCallback(async () => {
    try {
      const [a, h, q, e, v, hi] = await Promise.all([
        api.roadsideActive(), api.roadsideHelping(),
        api.roadsideQuote().catch(() => null),
        api.roadsideEligibility().catch(() => null),
        api.roadsideVerification().catch(() => null),
        api.roadsideHistory().catch(() => [] as RoadsideRequest[]),
      ]);
      setActive(a); setHelping(h); if (q) setQuote(q); if (e) setElig(e); if (v) setVerif(v); setHist(hi);
    } catch {}
    const loc = await detect(false);
    if (loc) {
      setCoords(loc.coords);
      setPlaceName((prev) => prev || loc.name);
      await loadNearby(loc.coords);
    } else {
      await loadNearby(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, [detect, loadNearby]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const useMyLocation = async () => {
    const loc = await detect(true);
    if (!loc) { Alert.alert("Location needed", "Enable location access so a helper can find you."); return; }
    setCoords(loc.coords); setPlaceName(loc.name); setNoLocation(false);
    loadNearby(loc.coords);
  };

  const pickDoc = async (which: "ins" | "own") => {
    try {
      const uri = await pickDocumentBase64();
      if (!uri) return;
      if (which === "ins") setInsuranceDoc(uri); else setOwnershipDoc(uri);
    } catch (e: any) { Alert.alert("Couldn't add document", String(e?.message || e)); }
  };

  const submitVerif = async () => {
    if (!insuranceDoc || !ownershipDoc) { setVerifErr("Add a photo of both documents."); return; }
    setVerifErr(null); setSubmittingVerif(true);
    try {
      const r = await api.submitRoadsideVerification({
        insurance_photo: insuranceDoc, ownership_photo: ownershipDoc,
        vehicle_year: vYear || undefined, vehicle_make: vMake || undefined, vehicle_model: vModel.trim() || undefined,
      });
      setInsuranceDoc(null); setOwnershipDoc(null);
      await load();
      if (r.status === "approved") Alert.alert("Verified ✓", "You're cleared to request roadside help.");
      else if (r.status === "rejected") Alert.alert("Couldn't verify", r.reason || "The documents didn't match. Use clearer photos that match your vehicle and name.");
      else Alert.alert("Submitted", "Your documents are under review. You'll be notified once approved.");
    } catch (e: any) {
      setVerifErr(String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setSubmittingVerif(false); }
  };

  // Our own camera UI (single shutter — no library/files). takePhoto() opens it
  // and resolves with the captured URI (or null if cancelled).
  const [camOpen, setCamOpen] = useState(false);
  const camResolver = useRef<((uri: string | null) => void) | null>(null);
  const takePhoto = (): Promise<string | null> =>
    new Promise((resolve) => { camResolver.current = resolve; setCamOpen(true); });
  const handleCaptured = (uri: string | null) => {
    setCamOpen(false);
    const resolve = camResolver.current;
    camResolver.current = null;
    resolve?.(uri);
  };

  // Roadside photos are camera-only (no library/files) and AI-checked to be a
  // real shot of the vehicle or the problem — not a blank/black or random photo.
  const verifyShot = async (uri: string): Promise<boolean> => {
    try {
      const res = await api.checkRoadsidePhoto(uri);
      if (!res.ok) {
        Alert.alert("Photo not accepted", res.reason || "Take a clear photo of your vehicle or the problem.");
        return false;
      }
      return true;
    } catch {
      return true; // don't hard-block on a network hiccup
    }
  };

  const addPhotos = async () => {
    setPhotoBusy(true);
    try {
      const uri = await takePhoto();   // our camera UI — one shot per tap
      if (uri && (await verifyShot(uri))) setPhotos((p) => [...p, uri].slice(0, 6));
    } catch (e: any) { Alert.alert("Couldn't add photo", String(e?.message || e)); }
    finally { setPhotoBusy(false); }
  };

  const runCheck = async () => {
    setChecking(true); setCheckRes(null);
    try {
      const res = await api.checkRoadsideForm({
        service: service || undefined,
        has_location: !!coords,
        place_name: placeName.trim() || undefined,
        dest_name: service === "tow" ? (destName.trim() || undefined) : undefined,
        fuel_type: service === "gas" ? (fuelType || undefined) : undefined,
        fuel_amount: service === "gas" ? (fuelAmount || undefined) : undefined,
        vehicle_year: vYear || undefined, vehicle_make: vMake || undefined, vehicle_model: vModel.trim() || undefined,
        vehicle_color: vColor.trim() || undefined, vehicle_plate: vPlate.trim() || undefined,
        note: note.trim() || undefined,
      });
      setCheckRes(res);
    } catch (e: any) {
      Alert.alert("Couldn't review", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setChecking(false); }
  };

  // The AI helps automatically — re-review whenever the draft changes.
  useEffect(() => {
    if (!service) { setCheckRes(null); return; }
    const t = setTimeout(() => { runCheck(); }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, coords, placeName, destName, fuelType, fuelAmount, vYear, vMake, vModel, vColor, vPlate, note]);

  const resetForm = () => {
    setService(null); setVModel(""); setVColor(""); setVPlate(""); setVYear(""); setVMake("");
    setDestName(""); setFuelType(""); setFuelAmount(""); setPhotos([]); setNote("");
  };

  // Load an open request back into the form to edit it (before a helper accepts).
  const startEdit = (r: RoadsideRequest) => {
    setEditingId(r.id);
    setErr(null); setCheckRes(null);
    setService(r.service);
    setCoords([r.longitude, r.latitude]);
    setPlaceName(r.place_name || "");
    setDestName(r.dest_name || "");
    setFuelType(r.fuel_type || "");
    setFuelAmount(r.fuel_amount || "");
    setVYear(r.vehicle_year || ""); setVMake(r.vehicle_make || ""); setVModel(r.vehicle_model || "");
    setVColor(r.vehicle_color || ""); setVPlate(r.vehicle_plate || "");
    setPhotos(r.photos || []);
    setNote(r.note || "");
    setPayMethod(r.payment_method === "cash" ? "cash" : "wallet");
  };

  const discardEdit = () => { setEditingId(null); setErr(null); resetForm(); };

  const submit = async () => {
    if (!service) { setErr("Choose what you need help with."); return; }
    if (!coords) { setErr("Set your location so a helper can reach you."); return; }
    if (service === "tow" && !destName.trim()) { setErr("Add where you'd like the vehicle towed."); return; }
    if (service === "gas" && (!fuelType || !fuelAmount)) { setErr("Choose how much gas you want and the fuel type."); return; }
    setErr(null); setSubmitting(true);
    const body = {
      service, longitude: coords[0], latitude: coords[1],
      payment_method: payMethod,
      place_name: placeName.trim() || undefined,
      dest_name: service === "tow" ? destName.trim() : undefined,
      fuel_type: service === "gas" ? fuelType : undefined,
      fuel_amount: service === "gas" ? fuelAmount : undefined,
      vehicle_year: vYear || undefined, vehicle_make: vMake || undefined, vehicle_model: vModel.trim() || undefined,
      vehicle_color: vColor.trim() || undefined, vehicle_plate: vPlate.trim() || undefined,
      photos: photos.length ? photos : undefined,
      note: note.trim() || undefined,
    };
    try {
      const r = editingId ? await api.editRoadside(editingId, body) : await api.createRoadside(body);
      setActive(r);
      setEditingId(null);
      resetForm();
    } catch (e: any) {
      const msg = String(e?.message || e).replace(/^\d{3}:\s*/, "");
      setErr(msg);
      if (/top up|insufficient/i.test(msg)) {
        Alert.alert("Top up needed", msg, [
          { text: "Not now", style: "cancel" },
          { text: "Top up wallet", onPress: () => router.push("/wallet") },
        ]);
      }
    } finally { setSubmitting(false); }
  };

  const doVerify = async (r: RoadsideRequest, clear: () => void) => {
    const uri = await takePhoto();
    if (!uri) return;
    if (!(await verifyShot(uri))) return;
    setBusyId(r.id);
    try {
      const updated = await api.verifyRoadside(r.id, [uri]);
      if (updated.status === "completed") { clear(); Alert.alert("All done", "Both sides verified — the job is complete and payment released."); }
      else if (updated.mine) setActive(updated);
      else setHelping(updated);
    } catch (e: any) {
      Alert.alert("Couldn't verify", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setBusyId(null); }
  };

  const addServicePhotos = async (r: RoadsideRequest, phase: "before" | "after") => {
    const uri = await takePhoto();
    if (!uri) return;
    if (!(await verifyShot(uri))) return;
    setBusyId(r.id);
    try {
      const updated = await api.addRoadsidePhotos(r.id, phase, [uri]);
      if (updated.mine) setActive(updated); else setHelping(updated);
    } catch (e: any) { Alert.alert("Couldn't add photos", String(e?.message || e)); }
    finally { setBusyId(null); }
  };

  const goEnroute = async (r: RoadsideRequest) => {
    setBusyId(r.id);
    try { setHelping(await api.enrouteRoadside(r.id)); } catch (e: any) { Alert.alert("Couldn't update", String(e?.message || e)); }
    finally { setBusyId(null); }
  };

  const goArrived = async (r: RoadsideRequest) => {
    setBusyId(r.id);
    try { setHelping(await api.arrivedRoadside(r.id)); } catch (e: any) { Alert.alert("Couldn't update", String(e?.message || e)); }
    finally { setBusyId(null); }
  };

  const cancelReq = async (r: RoadsideRequest) => {
    const fee = r.en_route && r.status === "accepted" ? (r.price || 80) / 2 : 0;
    const body = fee > 0
      ? `Your helper is already en route. You'll be refunded $${((r.total || 0) - fee).toFixed(2)} and they keep $${fee.toFixed(2)} for setting off.`
      : "You'll get a full refund.";
    // In-app confirm modal (works the same on web + native) — no browser dialog.
    const ok = await confirm({
      title: "Cancel request",
      message: body,
      confirmLabel: "Cancel request",
      cancelLabel: "Keep",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(r.id);
    try { await api.cancelRoadside(r.id); setActive(null); } catch (e: any) { Alert.alert("Couldn't cancel", String(e?.message || e)); } finally { setBusyId(null); }
  };

  const accept = async (r: RoadsideRequest) => {
    setBusyId(r.id);
    try {
      const updated = await api.acceptRoadside(r.id);
      setHelping(updated);
      setNearby((arr) => arr.filter((x) => x.id !== r.id));
      setCallDetail(null);
      setTab("helping");
    } catch (e: any) {
      Alert.alert("Couldn't accept", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
      loadNearby(coords);
    } finally { setBusyId(null); }
  };

  // Decline a service call: hide it from this helper's nearby list (this session).
  const decline = (r: RoadsideRequest) => {
    setDeclined((s) => new Set(s).add(r.id));
    setNearby((arr) => arr.filter((x) => x.id !== r.id));
    setCallDetail(null);
  };

  // 2-minute response timer on the accept/decline screen — auto-declines on expiry.
  useEffect(() => {
    if (!callDetail) return;
    const call = callDetail;
    const started = Date.now();
    setCountdown(AUTO_DECLINE_SECS);
    const t = setInterval(() => {
      const left = AUTO_DECLINE_SECS - Math.floor((Date.now() - started) / 1000);
      if (left <= 0) { clearInterval(t); decline(call); }
      else setCountdown(left);
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callDetail]);

  // Keep the nearby list fresh while helping, so calls others accept drop off.
  useEffect(() => {
    if (tab !== "nearby" || !coords) return;
    const t = setInterval(() => { loadNearby(coords); }, NEARBY_POLL_MS);
    return () => clearInterval(t);
  }, [tab, coords, loadNearby]);

  // If the open call gets taken by another helper, close the screen and say so.
  useEffect(() => {
    if (!callDetail) return;
    if (!nearby.some((r) => r.id === callDetail.id)) {
      setCallDetail(null);
      Alert.alert("Call taken", "Another helper just accepted this request.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearby]);

  // When your helping job ends (completed/cancelled), leave the "Your job" tab.
  useEffect(() => {
    if (tab === "helping" && !helping) setTab("nearby");
  }, [tab, helping]);

  const openReview = (r: RoadsideRequest) => { setReviewing(r); setReviewRating(5); setReviewText(""); };
  const submitReview = async () => {
    if (!reviewing) return;
    setReviewBusy(true);
    try {
      await api.reviewRoadside(reviewing.id, reviewRating, reviewText.trim() || undefined);
      setReviewing(null);
      await load();
    } catch (e: any) {
      Alert.alert("Couldn't submit review", String(e?.message || e).replace(/^\d{3}:\s*/, ""));
    } finally { setReviewBusy(false); }
  };
  const openDispute = async (r: RoadsideRequest) => {
    // In-app confirm modal (works the same on web + native) — no browser dialog.
    const ok = await confirm({
      title: "Open a dispute",
      message: "This opens a support ticket about this job (within 7 days of the service). The job is only marked disputed once you submit the ticket.",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    // Don't flag the dispute here — it's recorded only when the support ticket is
    // actually submitted (see the support compose). Backing out leaves no dispute.
    router.push({ pathname: "/support", params: { compose: "1", category: "dispute", subject: `Roadside dispute · ${SERVICE_META[r.service].label}`, related_type: "roadside", related_id: r.id } });
  };

  const messageUser = async (uid: string, name?: string) => {
    try { const conv = await api.getOrCreateConversation(uid); router.push({ pathname: "/chat/[id]", params: { id: conv.id, name: name || "Member" } }); } catch {}
  };
  const callUser = (phone?: string | null) => { if (phone) Linking.openURL(`tel:${phone}`).catch(() => {}); };
  const navigateTo = (lat: number, lng: number) => {
    const url = Platform.select({ ios: `maps://?daddr=${lat},${lng}`, default: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` }) as string;
    Linking.openURL(url).catch(() => {});
  };

  const PartyRow = ({ p, role }: { p?: RoadsideParty | null; role: string }) => {
    if (!p) return null;
    return (
      <View style={styles.partyRow}>
        <View style={styles.avatar}>
          {p.picture ? <Image source={{ uri: p.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(p.name?.[0] || "?").toUpperCase()}</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.partyName} numberOfLines={1}>{p.name}</Text>
          <Text style={styles.partyRole}>{role}</Text>
        </View>
        <TouchableOpacity style={styles.contactBtn} onPress={() => messageUser(p.user_id, p.name)} testID={`rs-msg-${p.user_id}`}>
          <Ionicons name="chatbubble-ellipses" size={18} color="#fff" />
        </TouchableOpacity>
        {!!p.phone && (
          <TouchableOpacity style={[styles.contactBtn, { backgroundColor: theme.success }]} onPress={() => callUser(p.phone)} testID={`rs-call-${p.user_id}`}>
            <Ionicons name="call" size={18} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const ServicePill = ({ svc }: { svc: RoadsideService }) => {
    const m = SERVICE_META[svc];
    return (
      <View style={styles.svcPill}>
        <Ionicons name={m.icon} size={15} color={theme.primary} />
        <Text style={styles.svcPillText}>{m.label}</Text>
      </View>
    );
  };

  const Meta = ({ r }: { r: RoadsideRequest }) => (
    <>
      {!!r.vehicle && <View style={styles.metaLine}><Ionicons name="car-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.vehicle}</Text></View>}
      {!!r.place_name && <View style={styles.metaLine}><Ionicons name="location" size={14} color={theme.textMuted} /><Text style={styles.metaText} numberOfLines={2}>{r.place_name}</Text></View>}
      {!!r.dest_name && <View style={styles.metaLine}><Ionicons name="flag" size={14} color={theme.textMuted} /><Text style={styles.metaText} numberOfLines={2}>Tow to: {r.dest_name}</Text></View>}
      {!!r.fuel_amount && <View style={styles.metaLine}><Ionicons name="water" size={14} color={theme.textMuted} /><Text style={styles.metaText}>Gas: {r.fuel_amount}{r.fuel_type ? ` · ${FUEL_TYPES.find((f) => f.k === r.fuel_type)?.label || r.fuel_type}` : ""}</Text></View>}
      {!!r.note && <View style={styles.metaLine}><Ionicons name="document-text-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.note}</Text></View>}
      {!!(r.photos && r.photos.length) && <Photos uris={r.photos} />}
    </>
  );

  const VerifyState = ({ r }: { r: RoadsideRequest }) => (
    <View style={styles.verifyRow}>
      <View style={styles.verifyChip}>
        <Ionicons name={r.requester_verified ? "checkmark-circle" : "ellipse-outline"} size={15} color={r.requester_verified ? theme.success : theme.textMuted} />
        <Text style={styles.verifyChipText}>Customer</Text>
      </View>
      <View style={styles.verifyChip}>
        <Ionicons name={r.helper_verified ? "checkmark-circle" : "ellipse-outline"} size={15} color={r.helper_verified ? theme.success : theme.textMuted} />
        <Text style={styles.verifyChipText}>Helper</Text>
      </View>
    </View>
  );

  const EligibilityCard = ({ e }: { e: RoadsideEligibility }) => (
    <View style={[styles.card, { borderColor: theme.warning + "66" }]}>
      <View style={styles.helpingTag}>
        <Ionicons name="shield-checkmark" size={16} color={theme.warning} />
        <Text style={[styles.helpingTagText, { color: theme.warning }]}>Become a roadside helper</Text>
      </View>
      <Text style={[styles.hint, { marginTop: 8 }]}>To keep stranded members safe, you can accept jobs once you meet all of these:</Text>
      <View style={{ marginTop: 12, gap: 9 }}>
        {e.requirements.map((req) => (
          <View key={req.key} style={styles.reqRow}>
            <Ionicons name={req.met ? "checkmark-circle" : "ellipse-outline"} size={18} color={req.met ? theme.success : theme.textMuted} />
            <Text style={[styles.reqText, req.met && { color: theme.textMuted, textDecorationLine: "line-through" }]}>{req.label}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity style={[styles.actBtn, styles.actPrimary, { marginTop: 14 }]} onPress={() => router.push("/account")} testID="rs-get-verified">
        <Text style={styles.actPrimaryText}>Manage verification</Text>
      </TouchableOpacity>
    </View>
  );

  const DocBox = ({ label, uri, onPress }: { label: string; uri: string | null; onPress: () => void }) => (
    <TouchableOpacity style={styles.docBox} onPress={onPress} testID={`rs-doc-${label}`}>
      {uri ? (
        <>
          <Image source={{ uri }} style={styles.docImg} resizeMode="cover" />
          <View style={styles.docCheck}><Ionicons name="checkmark-circle" size={20} color={theme.success} /></View>
        </>
      ) : (
        <>
          <Ionicons name="camera-outline" size={24} color={theme.primary} />
          <Text style={styles.docLabel}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );

  // ── Requester verification gate (insurance + ownership) ──
  const VerifyGate = () => {
    if (!verif) return null;
    if (!verif.eligibility.eligible) return <EligibilityCard e={verif.eligibility} />;
    if (verif.status === "pending") {
      return (
        <View style={styles.card}>
          <View style={styles.helpingTag}><Ionicons name="hourglass" size={16} color={theme.warning} /><Text style={[styles.helpingTagText, { color: theme.warning }]}>Documents under review</Text></View>
          <Text style={[styles.hint, { marginTop: 8 }]}>Your insurance and ownership are being reviewed. You'll be notified — once approved you can request help.</Text>
        </View>
      );
    }
    return (
      <View style={styles.card}>
        <View style={styles.helpingTag}><Ionicons name="shield-checkmark" size={16} color={theme.primary} /><Text style={styles.helpingTagText}>Verify to request help</Text></View>
        <Text style={[styles.hint, { marginTop: 8 }]}>
          To cut down on fraud, add your auto insurance and proof of ownership (registration or title). Our AI checks they match your vehicle, then the documents are deleted — we don't keep them.
        </Text>
        {verif.status === "rejected" && !!verif.reason && (
          <Text style={[styles.err, { marginTop: 10 }]}>Last attempt declined: {verif.reason}</Text>
        )}
        <Text style={styles.sectionLabel}>Vehicle (helps matching)</Text>
        <View style={styles.row2}>
          <View style={{ flex: 1 }}><Dropdown value={vYear} placeholder="Year" options={YEARS} onChange={setVYear} testID="rs-v-year" /></View>
          <View style={{ flex: 1 }}><Dropdown value={vMake} placeholder="Make" options={MAKES} onChange={setVMake} testID="rs-v-make" /></View>
        </View>
        <Text style={styles.sectionLabel}>Documents</Text>
        <View style={styles.row2}>
          <View style={{ flex: 1 }}><DocBox label="Insurance" uri={insuranceDoc} onPress={() => pickDoc("ins")} /></View>
          <View style={{ flex: 1 }}><DocBox label="Ownership" uri={ownershipDoc} onPress={() => pickDoc("own")} /></View>
        </View>
        {!!verifErr && <Text style={[styles.err, { marginTop: 10 }]}>{verifErr}</Text>}
        <TouchableOpacity
          style={[styles.actBtn, styles.actPrimary, { marginTop: 14 }, (!insuranceDoc || !ownershipDoc || submittingVerif) && { opacity: 0.5 }]}
          onPress={submitVerif}
          disabled={!insuranceDoc || !ownershipDoc || submittingVerif}
          testID="rs-verify-submit"
        >
          {submittingVerif ? <ActivityIndicator color="#fff" /> : <Text style={styles.actPrimaryText}>Submit for verification</Text>}
        </TouchableOpacity>
      </View>
    );
  };

  const Stars = ({ rating, onChange }: { rating: number; onChange?: (n: number) => void }) => (
    <View style={{ flexDirection: "row", gap: onChange ? 8 : 3 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <TouchableOpacity key={n} disabled={!onChange} onPress={() => onChange?.(n)} testID={`rs-star-${n}`}>
          <Ionicons name={n <= rating ? "star" : "star-outline"} size={onChange ? 30 : 14} color="#F5A623" />
        </TouchableOpacity>
      ))}
    </View>
  );

  // ── History card (review / dispute past jobs) ──
  const HistoryCard = ({ r }: { r: RoadsideRequest }) => {
    const s = STATUS_LABEL(r);
    const other = r.mine ? r.helper : r.requester;
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <ServicePill svc={r.service} />
          <View style={[styles.statusBadge, { backgroundColor: s.color + "22", borderColor: s.color }]}><Text style={[styles.statusText, { color: s.color }]}>{s.label}</Text></View>
        </View>
        {!!other && <Text style={styles.metaText}>{r.mine ? "Helper" : "Customer"}: {other.name}</Text>}
        {!!r.vehicle && <View style={styles.metaLine}><Ionicons name="car-outline" size={14} color={theme.textMuted} /><Text style={styles.metaText}>{r.vehicle}</Text></View>}
        <Text style={[styles.metaText, { marginTop: 6 }]}>
          {r.payment_method === "cash" ? `$${(r.price || 0).toFixed(2)} cash` : `$${(r.total || 0).toFixed(2)} wallet`} · {new Date(r.created_at).toLocaleDateString()}
        </Text>
        {r.disputed && <View style={styles.disputeBadge}><Ionicons name="alert-circle" size={13} color={theme.error} /><Text style={styles.disputeText}>Disputed</Text></View>}
        {!!r.their_review && (
          <View style={styles.reviewBox}><Text style={styles.reviewWho}>Their review of you</Text><Stars rating={r.their_review.rating} />{!!r.their_review.text && <Text style={styles.reviewQuote}>{r.their_review.text}</Text>}</View>
        )}
        {!!r.my_review && (
          <View style={styles.reviewBox}><Text style={styles.reviewWho}>Your review</Text><Stars rating={r.my_review.rating} />{!!r.my_review.text && <Text style={styles.reviewQuote}>{r.my_review.text}</Text>}</View>
        )}
        {(r.can_review || r.can_dispute) && (
          <View style={styles.cardActions}>
            {r.can_review && <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => openReview(r)} testID={`rs-review-${r.id}`}><Text style={styles.actPrimaryText}>Leave a review</Text></TouchableOpacity>}
            {r.can_dispute && <TouchableOpacity style={[styles.actBtn, styles.actDanger]} onPress={() => openDispute(r)} testID={`rs-dispute-${r.id}`}><Text style={styles.actDangerText}>Dispute</Text></TouchableOpacity>}
          </View>
        )}
      </View>
    );
  };

  // ── Active card (viewer is the requester) ──
  const ActiveCard = ({ r }: { r: RoadsideRequest }) => {
    const s = STATUS_LABEL(r);
    return (
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <ServicePill svc={r.service} />
          <View style={[styles.statusBadge, { backgroundColor: s.color + "22", borderColor: s.color }]}><Text style={[styles.statusText, { color: s.color }]}>{s.label}</Text></View>
        </View>
        <Meta r={r} />
        <Text style={styles.priceLine}>You paid ${(r.total || 0).toFixed(2)} (held) · helper earns ${((r.price || 0) + (r.fuel_cost || 0)).toFixed(2)} on completion</Text>
        {r.status === "open" && <Text style={styles.hint}>Notifying nearby members. You'll hear the moment someone accepts.</Text>}
        {r.status === "accepted" && <PartyRow p={r.helper} role={r.arrived ? "On location" : r.en_route ? "On the way to you" : "Assigned — getting ready"} />}
        {!!(r.before_photos?.length || r.after_photos?.length) && (
          <>
            {!!r.before_photos?.length && <><Text style={styles.photoLabel}>Before</Text><Photos uris={r.before_photos} /></>}
            {!!r.after_photos?.length && <><Text style={styles.photoLabel}>After</Text><Photos uris={r.after_photos} /></>}
          </>
        )}
        {r.status === "accepted" && <VerifyState r={r} />}
        {r.status === "accepted" && r.en_route && !r.arrived && (
          <Text style={styles.hint}>Your helper is on the way. You can confirm the job once they're on location.</Text>
        )}
        <View style={styles.cardActions}>
          {r.status === "accepted" && r.arrived && !r.requester_verified && (
            <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => doVerify(r, () => setActive(null))} disabled={busyId === r.id} testID="rs-verify">
              <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : "Take ‘after’ photo & verify"}</Text>
            </TouchableOpacity>
          )}
          {r.status === "accepted" && r.requester_verified && !r.helper_verified && (
            <View style={[styles.actBtn, styles.actGhost]}><Text style={styles.actGhostText}>Verified ✓ — waiting for helper</Text></View>
          )}
          {r.status === "open" && (
            <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={() => startEdit(r)} disabled={busyId === r.id} testID="rs-edit">
              <Text style={styles.actGhostText}>Edit</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.actBtn, styles.actDanger]} onPress={() => cancelReq(r)} disabled={busyId === r.id} testID="rs-cancel">
            <Text style={styles.actDangerText}>Cancel</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.refundNote}>{r.en_route ? "Cancelling now refunds all but half the $80 (the helper already set off)." : "Cancel any time before your helper sets off for a full refund."}</Text>
      </View>
    );
  };

  // ── Helping card (viewer accepted someone else's request) ──
  const HelpingCard = ({ r }: { r: RoadsideRequest }) => (
    <View style={[styles.card, { borderColor: theme.primary + "66" }]}>
      <View style={styles.cardHead}>
        <View style={styles.helpingTag}><Ionicons name="navigate" size={13} color={theme.primary} /><Text style={styles.helpingTagText}>You're helping · earn ${((r.price || 0) + (r.fuel_cost || 0)).toFixed(2)}</Text></View>
        <ServicePill svc={r.service} />
      </View>
      <PartyRow p={r.requester} role="Stranded member" />
      <View style={styles.phaseRow}>
        <Ionicons name={r.arrived ? "location" : r.en_route ? "navigate" : "time-outline"} size={14} color={r.arrived ? theme.success : theme.primary} />
        <Text style={[styles.phaseText, r.arrived && { color: theme.success }]}>
          {r.arrived ? "You're on location" : r.en_route ? "En route to the member" : "Accepted — set off when you're ready"}
        </Text>
      </View>
      <Meta r={r} />
      {!!r.before_photos?.length && <><Text style={styles.photoLabel}>Before</Text><Photos uris={r.before_photos} /></>}
      {!!r.after_photos?.length && <><Text style={styles.photoLabel}>After</Text><Photos uris={r.after_photos} /></>}
      <VerifyState r={r} />
      <View style={styles.cardActions}>
        <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={() => navigateTo(r.latitude, r.longitude)} testID="rs-navigate">
          <Text style={styles.actGhostText}>Navigate</Text>
        </TouchableOpacity>
        {!r.en_route ? (
          <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => goEnroute(r)} disabled={busyId === r.id} testID="rs-enroute">
            <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : "I'm on my way"}</Text>
          </TouchableOpacity>
        ) : !r.arrived ? (
          <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => goArrived(r)} disabled={busyId === r.id} testID="rs-arrived">
            <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : "I'm on location"}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {r.arrived && (
        <View style={styles.cardActions}>
          <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={() => addServicePhotos(r, "before")} disabled={busyId === r.id} testID="rs-before">
            <Text style={styles.actGhostText}>{r.before_photos?.length ? "Add before photo" : "Add ‘before’ photo"}</Text>
          </TouchableOpacity>
          {!r.helper_verified ? (
            <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => doVerify(r, () => setHelping(null))} disabled={busyId === r.id} testID="rs-helper-verify">
              <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : "‘After’ photo & verify"}</Text>
            </TouchableOpacity>
          ) : (
            <View style={[styles.actBtn, styles.actGhost]}><Text style={styles.actGhostText}>Verified ✓ — waiting</Text></View>
          )}
        </View>
      )}
      <Text style={styles.refundNote}>Add a ‘before’ photo, do the job, then both take an ‘after’ photo and verify to release the ${((r.price || 0) + (r.fuel_cost || 0)).toFixed(2)}.</Text>
    </View>
  );

  const vehicleSummary = (() => {
    const head = [vYear, vMake, vModel.trim()].filter(Boolean).join(" ");
    const extra = [vColor.trim(), vPlate.trim()].filter(Boolean).join(" · ");
    return [head, extra].filter(Boolean).join(" · ");
  })();
  const baseFee = quote?.base ?? 80;
  const taxAmt = quote?.tax ?? 8;
  const gasCost = service === "gas" ? (parseFloat((fuelAmount || "").replace(/[^0-9.]/g, "")) || 0) : 0;
  const walletTotal = baseFee + taxAmt + gasCost;
  const cashTotal = baseFee + gasCost;
  const total = payMethod === "cash" ? cashTotal : walletTotal;
  const bal = quote?.wallet_balance ?? 0;
  // When editing, the original total is already held — only the difference needs
  // funding, so check the wallet against the extra amount, not the full total.
  const heldAlready = editingId && active && active.id === editingId && active.held && !active.settled && !active.refunded ? (active.total || 0) : 0;
  const extraNeeded = payMethod === "wallet" ? Math.max(0, walletTotal - heldAlready) : 0;
  const lowFunds = payMethod === "wallet" && !!quote && bal + 1e-9 < extraNeeded;

  return (
    <SafeAreaView edges={["top"]} style={styles.root} testID="roadside-screen">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => safeBack("/")} style={styles.iconBtn} testID="roadside-back">
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Roadside help</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.tabs}>
        {(helping
          ? (["request", "nearby", "helping", "history"] as const)
          : (["request", "nearby", "history"] as const)
        ).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabOn]} onPress={() => setTab(t)} testID={`roadside-tab-${t}`}>
            <Text style={[styles.tabText, tab === t && styles.tabTextOn]} numberOfLines={1}>
              {t === "request" ? "Get help" : t === "nearby" ? "Help others" : t === "helping" ? "Your job" : "History"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={theme.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={theme.primary} />}
        >
          {tab === "request" ? (
            <>
              {active && !editingId ? (
                <ActiveCard r={active} />
              ) : (!active && verif && !verif.verified) ? (
                <VerifyGate />
              ) : (
                <>
                  {!!editingId && (
                    <View style={styles.editBanner}>
                      <Ionicons name="create-outline" size={16} color={theme.primary} />
                      <Text style={styles.editBannerText}>Editing your request</Text>
                      <TouchableOpacity onPress={discardEdit} testID="rs-edit-discard">
                        <Text style={styles.editBannerDiscard}>Discard</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  <Text style={styles.sectionLabel}>What do you need?</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 2 }}>
                    {SERVICE_ORDER.map((k) => {
                      const m = SERVICE_META[k]; const on = service === k;
                      return (
                        <TouchableOpacity key={k} style={[styles.svcChip, on && styles.svcChipOn]} onPress={() => setService(k)} testID={`rs-svc-${k}`}>
                          <Ionicons name={m.icon} size={20} color={on ? "#fff" : theme.primary} />
                          <Text style={[styles.svcChipText, on && { color: "#fff" }]}>{m.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                  {!!service && <Text style={styles.svcDescLine}>{SERVICE_META[service].desc}</Text>}

                  <Text style={styles.sectionLabel}>Vehicle</Text>
                  <TouchableOpacity style={styles.vehRow} onPress={() => setVehicleOpen(true)} testID="rs-vehicle-open">
                    <Ionicons name="car-outline" size={18} color={theme.primary} />
                    <Text style={[styles.vehRowText, !vehicleSummary && { color: theme.textMuted }]} numberOfLines={1}>{vehicleSummary || "Add vehicle details"}</Text>
                    <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
                  </TouchableOpacity>

                  <Text style={styles.sectionLabel}>Your location</Text>
                  <TouchableOpacity style={styles.locBtn} onPress={useMyLocation} disabled={locating} testID="rs-use-location">
                    {locating ? <ActivityIndicator color={theme.primary} size="small" /> : <Ionicons name="navigate" size={16} color={theme.primary} />}
                    <Text style={styles.locBtnText}>{coords ? "Update to current location" : "Use my current location"}</Text>
                  </TouchableOpacity>
                  <TextInput style={styles.input} placeholder="Address or landmark" placeholderTextColor={theme.textMuted} value={placeName} onChangeText={setPlaceName} testID="rs-place" />

                  {service === "tow" && (
                    <>
                      <Text style={styles.sectionLabel}>Tow destination</Text>
                      <TextInput style={[styles.input, { marginTop: 0 }]} placeholder="Where should it be towed? (shop / home address)" placeholderTextColor={theme.textMuted} value={destName} onChangeText={setDestName} testID="rs-dest" />
                    </>
                  )}

                  {service === "gas" && (
                    <>
                      <Text style={styles.sectionLabel}>Gas — how much ($)?</Text>
                      <Dropdown value={fuelAmount} placeholder="Dollar amount" options={GAS_AMOUNTS} onChange={setFuelAmount} testID="rs-fuel-amount" />
                      <Text style={styles.svcDescLine}>You pay the driver for the gas; the $80 is the delivery service call.</Text>
                      <Text style={styles.sectionLabel}>Fuel type (no diesel)</Text>
                      <View style={styles.row2}>
                        {FUEL_TYPES.map((f) => (
                          <TouchableOpacity key={f.k} style={[styles.payPill, fuelType === f.k && styles.payPillOn]} onPress={() => setFuelType(f.k)} testID={`rs-fuel-${f.k}`}>
                            <Text style={[styles.payText, fuelType === f.k && { color: theme.primary }]}>{f.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}

                  <Text style={styles.sectionLabel}>Photos (optional)</Text>
                  <TouchableOpacity style={styles.locBtn} onPress={addPhotos} disabled={photoBusy || photos.length >= 6} testID="rs-add-photos">
                    {photoBusy ? <ActivityIndicator color={theme.primary} size="small" /> : <Ionicons name="camera" size={16} color={theme.primary} />}
                    <Text style={styles.locBtnText}>Take a photo of the problem</Text>
                  </TouchableOpacity>
                  <Text style={[styles.hint, { marginTop: 6 }]}>Camera only — snap your vehicle or the issue (a flat tyre, dead battery…). Photos are checked automatically.</Text>
                  <Photos uris={photos} onRemove={(i) => setPhotos((p) => p.filter((_, idx) => idx !== i))} />

                  <Text style={styles.sectionLabel}>Notes (optional)</Text>
                  <TextInput style={[styles.input, styles.textarea, { marginTop: 0 }]} placeholder="Anything that helps — which tire is flat, are you somewhere safe…" placeholderTextColor={theme.textMuted} value={note} onChangeText={setNote} maxLength={500} multiline testID="rs-note" />

                  <Text style={styles.sectionLabel}>Payment</Text>
                  <View style={styles.row2}>
                    <TouchableOpacity style={[styles.payPill, payMethod === "wallet" && styles.payPillOn]} onPress={() => setPayMethod("wallet")} testID="rs-pay-wallet">
                      <Ionicons name="wallet-outline" size={16} color={payMethod === "wallet" ? theme.primary : theme.textMuted} />
                      <Text style={[styles.payText, payMethod === "wallet" && { color: theme.primary }]}>Wallet (held)</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.payPill, payMethod === "cash" && styles.payPillOn]} onPress={() => setPayMethod("cash")} testID="rs-pay-cash">
                      <Ionicons name="cash-outline" size={16} color={payMethod === "cash" ? theme.primary : theme.textMuted} />
                      <Text style={[styles.payText, payMethod === "cash" && { color: theme.primary }]}>Cash in person</Text>
                    </TouchableOpacity>
                  </View>

                  {payMethod === "cash" ? (
                    <View style={styles.priceBox}>
                      <View style={styles.priceRow}><Text style={styles.priceK}>Service fee</Text><Text style={styles.priceV}>${baseFee.toFixed(2)}</Text></View>
                      {gasCost > 0 && <View style={styles.priceRow}><Text style={styles.priceK}>Gas</Text><Text style={styles.priceV}>${gasCost.toFixed(2)}</Text></View>}
                      <View style={[styles.priceRow, styles.priceTotal, { marginBottom: 0 }]}><Text style={styles.priceKt}>Pay your helper (cash)</Text><Text style={styles.priceVt}>${cashTotal.toFixed(2)}</Text></View>
                      <Text style={[styles.priceNote, { marginTop: 8 }]}>No card or hold needed — hand your helper ${cashTotal.toFixed(2)} in cash when the job's done. Both of you still verify with photos.</Text>
                    </View>
                  ) : (
                    <View style={styles.priceBox}>
                      <View style={styles.priceRow}><Text style={styles.priceK}>Service fee</Text><Text style={styles.priceV}>${baseFee.toFixed(2)}</Text></View>
                      {gasCost > 0 && <View style={styles.priceRow}><Text style={styles.priceK}>Gas</Text><Text style={styles.priceV}>${gasCost.toFixed(2)}</Text></View>}
                      <View style={styles.priceRow}><Text style={styles.priceK}>Tax &amp; fees{quote ? ` (${Math.round((quote.tax_rate || 0) * 100)}%)` : ""}</Text><Text style={styles.priceV}>${taxAmt.toFixed(2)}</Text></View>
                      <View style={[styles.priceRow, styles.priceTotal]}><Text style={styles.priceKt}>Total (held until done)</Text><Text style={styles.priceVt}>${walletTotal.toFixed(2)}</Text></View>
                      <Text style={styles.priceNote}>Wallet balance ${bal.toFixed(2)}. The service fee{gasCost > 0 ? " + gas" : ""} goes to your helper once both of you verify; tax is a platform fee.</Text>
                      {lowFunds && (
                        <TouchableOpacity style={styles.topupBtn} onPress={() => router.push("/wallet")} testID="rs-topup">
                          <Ionicons name="add-circle" size={16} color="#fff" />
                          <Text style={styles.topupText}>Top up ${(extraNeeded - bal).toFixed(2)} more</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {checking ? (
                    <View style={styles.checkCard}>
                      <ActivityIndicator color={theme.primary} size="small" />
                      <Text style={styles.checkOkText}>AI is reviewing your request…</Text>
                    </View>
                  ) : checkRes ? (
                    checkRes.ok ? (
                      <View style={[styles.checkCard, { borderColor: theme.success + "66" }]}>
                        <Ionicons name="checkmark-circle" size={18} color={theme.success} />
                        <Text style={styles.checkOkText}>AI checked it — looks good, everything's filled out.</Text>
                      </View>
                    ) : (
                      <View style={[styles.checkCard, checkRes.block && { borderColor: theme.error + "66" }]}>
                        <View style={{ flex: 1 }}>
                          <View style={styles.checkHead}>
                            <Ionicons name={checkRes.block ? "close-circle" : "sparkles"} size={14} color={checkRes.block ? theme.error : theme.primary} />
                            <Text style={[styles.checkTitle, checkRes.block && { color: theme.error }]}>{checkRes.block ? "Fix your vehicle to continue" : "AI suggestions"}</Text>
                          </View>
                          {checkRes.issues.map((it, i) => (
                            <View key={i} style={styles.checkIssue}>
                              <Ionicons name="alert-circle" size={14} color={checkRes.block ? theme.error : theme.warning} style={{ marginTop: 2 }} />
                              <Text style={styles.checkIssueText}>{it.message}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    )
                  ) : null}

                  {!!err && <Text style={styles.err}>{err}</Text>}
                  {(() => {
                    const blockFunds = payMethod === "wallet" && lowFunds;
                    const blockVehicle = !!checkRes?.block;
                    return (
                      <TouchableOpacity style={[styles.submit, (!service || !coords || submitting || blockFunds || blockVehicle) && { opacity: 0.5 }]} onPress={submit} disabled={!service || !coords || submitting || blockFunds || blockVehicle} testID="rs-submit">
                        {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{blockVehicle ? "Fix the vehicle to continue" : `${editingId ? "Save changes" : "Request help"} · $${(payMethod === "cash" ? cashTotal : walletTotal).toFixed(2)}${payMethod === "cash" ? " cash" : ""}`}</Text>}
                      </TouchableOpacity>
                    );
                  })()}
                  <Text style={styles.disclaimer}>Help is provided by other members, not a professional service. Stay somewhere safe while you wait. For emergencies, call your local emergency number.</Text>
                </>
              )}
            </>
          ) : tab === "helping" ? (
            helping ? (
              <HelpingCard r={helping} />
            ) : (
              <View style={styles.empty}>
                <Ionicons name="construct-outline" size={36} color={theme.textMuted} />
                <Text style={styles.emptyText}>You're not helping anyone right now. Accept a call from "Help others".</Text>
              </View>
            )
          ) : tab === "nearby" ? (
            <>
              {noLocation ? (
                <View style={styles.empty}>
                  <Ionicons name="location-outline" size={36} color={theme.textMuted} />
                  <Text style={styles.emptyText}>Enable location to see nearby members who need a hand.</Text>
                  <TouchableOpacity style={styles.locBtn} onPress={useMyLocation} testID="rs-enable-location"><Ionicons name="navigate" size={16} color={theme.primary} /><Text style={styles.locBtnText}>Use my location</Text></TouchableOpacity>
                </View>
              ) : (
                <>
                  {elig && !elig.eligible && <EligibilityCard e={elig} />}
                  {nearby.filter((r) => !declined.has(r.id)).length === 0 ? (
                    <View style={styles.empty}><Ionicons name="checkmark-done-outline" size={36} color={theme.textMuted} /><Text style={styles.emptyText}>No one needs roadside help near you right now.</Text></View>
                  ) : (
                    nearby.filter((r) => !declined.has(r.id)).map((r) => (
                      <TouchableOpacity key={r.id} style={styles.card} activeOpacity={0.85} onPress={() => setCallDetail(r)} testID={`rs-call-${r.id}`}>
                        <View style={styles.cardHead}>
                          <ServicePill svc={r.service} />
                          {r.distance_km != null && <Text style={styles.dist}>{r.distance_km} km away</Text>}
                        </View>
                        <View style={styles.callRow}>
                          <View style={styles.avatar}>
                            {r.requester?.picture ? <Image source={{ uri: r.requester.picture }} style={styles.avatarImg} /> : <Text style={styles.avatarInit}>{(r.requester?.name?.[0] || "?").toUpperCase()}</Text>}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.partyName} numberOfLines={1}>{r.requester?.name || "Member"}</Text>
                            {!!r.vehicle && <Text style={styles.metaText} numberOfLines={1}>{r.vehicle}</Text>}
                            {!!r.place_name && <Text style={styles.metaText} numberOfLines={1}>{r.place_name}</Text>}
                          </View>
                          <Ionicons name="chevron-forward" size={18} color={theme.textMuted} />
                        </View>
                        <View style={styles.callFoot}>
                          <Text style={styles.earnHint}>Earn ${((r.price || 80) + (r.fuel_cost || 0)).toFixed(2)}</Text>
                          {!!(r.photos && r.photos.length) && (
                            <View style={styles.photoCount}><Ionicons name="image-outline" size={13} color={theme.textMuted} /><Text style={styles.photoCountText}>{r.photos.length}</Text></View>
                          )}
                          <Text style={styles.tapHint}>Tap to respond</Text>
                        </View>
                      </TouchableOpacity>
                    ))
                  )}
                </>
              )}
            </>
          ) : (
            <>
              {hist.length === 0 ? (
                <View style={styles.empty}><Ionicons name="time-outline" size={36} color={theme.textMuted} /><Text style={styles.emptyText}>No recent roadside jobs yet.</Text></View>
              ) : hist.map((r) => <HistoryCard key={r.id} r={r} />)}
            </>
          )}
        </ScrollView>
      )}

      <Modal visible={!!reviewing} transparent animationType="fade" onRequestClose={() => setReviewing(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.reviewBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setReviewing(null)} />
          <View style={styles.reviewCard}>
            <Text style={styles.reviewTitle}>Rate {reviewing?.mine ? reviewing?.helper?.name || "your helper" : reviewing?.requester?.name || "the member"}</Text>
            <View style={{ alignItems: "center", marginVertical: 12 }}>
              <Stars rating={reviewRating} onChange={setReviewRating} />
            </View>
            <TextInput
              style={styles.reviewInput} value={reviewText} onChangeText={setReviewText} multiline maxLength={500}
              placeholder="Add a comment (optional)" placeholderTextColor={theme.textMuted} testID="rs-review-text"
            />
            <View style={styles.cardActions}>
              <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={() => setReviewing(null)}><Text style={styles.actGhostText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={submitReview} disabled={reviewBusy} testID="rs-review-submit">
                <Text style={styles.actPrimaryText}>{reviewBusy ? "…" : "Submit"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={vehicleOpen} transparent animationType="slide" onRequestClose={() => setVehicleOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.vehBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setVehicleOpen(false)} />
          <View style={[styles.vehSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.vehHead}>
              <Text style={styles.vehTitle}>Vehicle details</Text>
              <TouchableOpacity onPress={() => setVehicleOpen(false)} testID="rs-vehicle-close"><Ionicons name="close" size={22} color={theme.textPrimary} /></TouchableOpacity>
            </View>
            <View style={styles.row2}>
              <View style={{ flex: 1 }}><Dropdown value={vYear} placeholder="Year" options={YEARS} onChange={setVYear} testID="rs-year" /></View>
              <View style={{ flex: 1 }}><Dropdown value={vMake} placeholder="Make" options={MAKES} onChange={setVMake} testID="rs-make" /></View>
            </View>
            <TextInput style={styles.input} placeholder="Model (e.g. Civic)" placeholderTextColor={theme.textMuted} value={vModel} onChangeText={setVModel} maxLength={60} testID="rs-model" />
            <View style={[styles.row2, { marginTop: 8 }]}>
              <TextInput style={[styles.input, { flex: 1, marginTop: 0 }]} placeholder="Color" placeholderTextColor={theme.textMuted} value={vColor} onChangeText={setVColor} maxLength={30} testID="rs-color" />
              <TextInput style={[styles.input, { flex: 1, marginTop: 0 }]} placeholder="Plate" placeholderTextColor={theme.textMuted} value={vPlate} onChangeText={setVPlate} autoCapitalize="characters" maxLength={16} testID="rs-plate" />
            </View>
            <TouchableOpacity style={styles.vehDone} onPress={() => setVehicleOpen(false)} testID="rs-vehicle-done"><Text style={styles.vehDoneText}>Done</Text></TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Accept / decline a service call (helper) */}
      <Modal visible={!!callDetail} transparent animationType="slide" onRequestClose={() => setCallDetail(null)}>
        <View style={styles.vehBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setCallDetail(null)} />
          <View style={[styles.detailSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.vehHead}>
              <Text style={styles.vehTitle}>Service call</Text>
              <TouchableOpacity onPress={() => setCallDetail(null)} testID="rs-detail-close"><Ionicons name="close" size={22} color={theme.textPrimary} /></TouchableOpacity>
            </View>
            <View style={[styles.timerPill, countdown <= 30 && styles.timerPillUrgent]}>
              <Ionicons name="time-outline" size={14} color={countdown <= 30 ? theme.error : theme.warning} />
              <Text style={[styles.timerText, countdown <= 30 && { color: theme.error }]}>
                Respond within {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")} — auto-declines
              </Text>
            </View>
            {!!callDetail && (() => {
              const r = callDetail;
              const blocked = !!elig && !elig.eligible;
              const earn = ((r.price || 80) + (r.fuel_cost || 0)).toFixed(2);
              return (
                <>
                  <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ paddingBottom: 8 }} showsVerticalScrollIndicator={false}>
                    <View style={[styles.cardHead, { marginTop: 2 }]}>
                      <ServicePill svc={r.service} />
                      {r.distance_km != null && <Text style={styles.dist}>{r.distance_km} km away</Text>}
                    </View>
                    <PartyRow p={r.requester} role="Needs a hand" />
                    {!!r.requester?.phone ? (
                      <TouchableOpacity style={styles.contactLine} onPress={() => callUser(r.requester?.phone)} testID="rs-detail-call">
                        <Ionicons name="call-outline" size={16} color={theme.primary} />
                        <Text style={styles.contactLineText}>{r.requester.phone}</Text>
                      </TouchableOpacity>
                    ) : (
                      <Text style={styles.phoneNote}>Their phone number is shared once you accept this call.</Text>
                    )}
                    <Meta r={r} />
                    <View style={styles.earnBox}>
                      <Text style={styles.earnBoxText}>You earn ${earn}</Text>
                      <Text style={styles.earnBoxSub}>{r.payment_method === "cash" ? "Paid in cash on completion" : "Released from escrow once you both verify"}</Text>
                    </View>
                  </ScrollView>
                  <View style={styles.cardActions}>
                    <TouchableOpacity style={[styles.actBtn, styles.actDanger]} onPress={() => decline(r)} testID="rs-decline">
                      <Text style={styles.actDangerText}>Decline</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actBtn, styles.actPrimary, blocked && { opacity: 0.5 }]} onPress={() => accept(r)} disabled={busyId === r.id || blocked} testID="rs-accept">
                      <Text style={styles.actPrimaryText}>{busyId === r.id ? "…" : blocked ? "Verify to help" : "Accept & help"}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              );
            })()}
          </View>
        </View>
      </Modal>

      <CameraCapture visible={camOpen} onClose={() => handleCaptured(null)} onCaptured={handleCaptured} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  tabs: { flexDirection: "row", paddingHorizontal: 14, gap: 8, paddingVertical: 10 },
  tab: { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: 999, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  tabOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  tabText: { color: theme.textSecondary, fontSize: 14, fontWeight: "800" },
  tabTextOn: { color: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  sectionLabel: { color: theme.textMuted, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 7 },
  svcChip: { width: 86, alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 14, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
  svcChipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  svcChipText: { color: theme.textPrimary, fontSize: 12, fontWeight: "800" },
  svcDescLine: { color: theme.textMuted, fontSize: 12.5, marginTop: 8 },

  row2: { flexDirection: "row", gap: 8 },
  vehRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13 },
  vehRowText: { flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: "600" },
  vehBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  vehSheet: { backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1, borderColor: theme.border, paddingHorizontal: 16, paddingTop: 14 },
  vehHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  vehTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: "800" },
  vehDone: { backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  vehDoneText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  dropdown: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13 },
  dropdownText: { color: theme.textPrimary, fontSize: 14.5, fontWeight: "600", flex: 1, marginRight: 8 },
  ddBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 30 },
  ddSheet: { backgroundColor: theme.surface, borderRadius: 16, borderWidth: 1, borderColor: theme.border, maxHeight: "70%", overflow: "hidden" },
  ddRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  ddRowText: { color: theme.textPrimary, fontSize: 15 },

  locBtn: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", backgroundColor: theme.primary + "1a", borderWidth: 1, borderColor: theme.primary + "55", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  locBtnText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  input: { color: theme.textPrimary, fontSize: 14.5, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginTop: 8, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
  textarea: { minHeight: 84, textAlignVertical: "top" },
  err: { color: theme.error, fontSize: 13, marginTop: 12 },
  submit: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 14, alignItems: "center", marginTop: 14 },
  submitText: { color: "#fff", fontSize: 15.5, fontWeight: "800" },
  checkBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 12, borderWidth: 1, borderColor: theme.primary + "66", backgroundColor: theme.primary + "12", paddingVertical: 11, marginTop: 14 },
  checkBtnText: { color: theme.primary, fontSize: 14, fontWeight: "800" },
  checkCard: { flexDirection: "row", gap: 10, backgroundColor: theme.surface, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 14, marginTop: 10 },
  checkOkText: { flex: 1, color: theme.textSecondary, fontSize: 13.5, fontWeight: "600" },
  checkHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  checkTitle: { color: theme.textPrimary, fontSize: 13.5, fontWeight: "800" },
  checkIssue: { flexDirection: "row", gap: 8, marginTop: 6 },
  checkIssueText: { flex: 1, color: theme.textSecondary, fontSize: 13.5, lineHeight: 18 },
  disclaimer: { color: theme.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 14, textAlign: "center" },
  editBanner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: theme.primary + "12", borderWidth: 1, borderColor: theme.primary + "55",
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 4,
  },
  editBannerText: { flex: 1, color: theme.textPrimary, fontSize: 13.5, fontWeight: "800" },
  editBannerDiscard: { color: theme.primary, fontSize: 13.5, fontWeight: "800" },

  priceBox: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 14, padding: 14, marginTop: 14 },
  priceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  priceK: { color: theme.textSecondary, fontSize: 14 },
  priceV: { color: theme.textPrimary, fontSize: 14, fontWeight: "700" },
  priceTotal: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 10, marginTop: 2, marginBottom: 6 },
  priceKt: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  priceVt: { color: theme.primary, fontSize: 17, fontWeight: "900" },
  priceNote: { color: theme.textMuted, fontSize: 11.5, lineHeight: 16 },
  topupBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: theme.primary, borderRadius: 10, paddingVertical: 11, marginTop: 12 },
  topupText: { color: "#fff", fontSize: 14, fontWeight: "800" },

  card: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 18, padding: 16, marginBottom: 14 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  svcPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.primary + "1f", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  svcPillText: { color: theme.primary, fontSize: 13, fontWeight: "800" },
  statusBadge: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  statusText: { fontSize: 11.5, fontWeight: "800" },
  dist: { color: theme.textMuted, fontSize: 12.5, fontWeight: "700" },
  metaLine: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 },
  metaText: { flex: 1, color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },
  hint: { color: theme.textMuted, fontSize: 13, lineHeight: 18, marginTop: 12 },
  priceLine: { color: theme.textMuted, fontSize: 12.5, marginTop: 12, fontWeight: "600" },
  refundNote: { color: theme.textMuted, fontSize: 11.5, lineHeight: 16, marginTop: 12 },
  phaseRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 10 },
  phaseText: { color: theme.primary, fontSize: 13, fontWeight: "800" },
  photoLabel: { color: theme.textMuted, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 12 },
  photoWrap: { width: 78, height: 78, borderRadius: 10, overflow: "hidden", position: "relative", backgroundColor: theme.surfaceAlt },
  photo: { width: "100%", height: "100%" },
  photoX: { position: "absolute", top: 3, right: 3, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },

  verifyRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  verifyChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: theme.surfaceAlt, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  verifyChipText: { color: theme.textSecondary, fontSize: 12.5, fontWeight: "700" },

  partyRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, backgroundColor: theme.surfaceAlt, borderRadius: 14, padding: 10 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarImg: { width: "100%", height: "100%" },
  avatarInit: { color: "#fff", fontSize: 17, fontWeight: "800" },
  partyName: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  partyRole: { color: theme.textMuted, fontSize: 12, marginTop: 1 },
  contactBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: theme.primary, alignItems: "center", justifyContent: "center" },

  // Nearby service-call summary card + accept/decline detail sheet
  callRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 4 },
  callFoot: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12 },
  earnHint: { color: theme.primary, fontSize: 13.5, fontWeight: "800" },
  photoCount: { flexDirection: "row", alignItems: "center", gap: 4 },
  photoCountText: { color: theme.textMuted, fontSize: 12, fontWeight: "600" },
  tapHint: { marginLeft: "auto", color: theme.textMuted, fontSize: 12, fontWeight: "700" },
  detailSheet: {
    backgroundColor: theme.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: theme.border, paddingHorizontal: 16, paddingTop: 14, maxHeight: "88%",
  },
  timerPill: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center", backgroundColor: theme.warning + "1f", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 10 },
  timerPillUrgent: { backgroundColor: theme.error + "1f" },
  timerText: { color: theme.warning, fontSize: 12.5, fontWeight: "800" },
  contactLine: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10, backgroundColor: theme.surfaceAlt, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  contactLineText: { color: theme.primary, fontSize: 14.5, fontWeight: "700" },
  phoneNote: { color: theme.textMuted, fontSize: 12, marginTop: 10 },
  earnBox: { marginTop: 14, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 12 },
  earnBoxText: { color: theme.textPrimary, fontSize: 15, fontWeight: "800" },
  earnBoxSub: { color: theme.textMuted, fontSize: 12, marginTop: 2 },

  cardActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  actBtn: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  actPrimary: { backgroundColor: theme.primary },
  actPrimaryText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  actGhost: { backgroundColor: theme.surfaceAlt, borderWidth: 1, borderColor: theme.border },
  actGhostText: { color: theme.textSecondary, fontSize: 14, fontWeight: "800" },
  actDanger: { backgroundColor: theme.error + "1a", borderWidth: 1, borderColor: theme.error + "55" },
  actDangerText: { color: theme.error, fontSize: 14, fontWeight: "800" },

  helpingTag: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  helpingTagText: { color: theme.primary, fontSize: 13, fontWeight: "900", flexShrink: 1 },
  reqRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  reqText: { color: theme.textPrimary, fontSize: 14, fontWeight: "600", flex: 1 },
  docBox: { height: 110, borderRadius: 12, borderWidth: 1, borderColor: theme.border, borderStyle: "dashed", backgroundColor: theme.surfaceAlt, alignItems: "center", justifyContent: "center", gap: 6, overflow: "hidden", position: "relative" },
  docImg: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  docLabel: { color: theme.textSecondary, fontSize: 13, fontWeight: "700" },
  docCheck: { position: "absolute", top: 6, right: 6, backgroundColor: theme.bg, borderRadius: 11 },

  empty: { alignItems: "center", gap: 12, paddingVertical: 50 },
  emptyText: { color: theme.textMuted, fontSize: 14, textAlign: "center", paddingHorizontal: 30, lineHeight: 20 },

  payPill: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 12 },
  payPillOn: { borderColor: theme.primary, backgroundColor: theme.primary + "12" },
  payText: { color: theme.textSecondary, fontSize: 13.5, fontWeight: "800" },

  disputeBadge: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", backgroundColor: theme.error + "1a", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginTop: 8 },
  disputeText: { color: theme.error, fontSize: 12, fontWeight: "800" },
  reviewBox: { backgroundColor: theme.surfaceAlt, borderRadius: 12, padding: 12, marginTop: 10, gap: 6 },
  reviewWho: { color: theme.textMuted, fontSize: 11.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  reviewQuote: { color: theme.textSecondary, fontSize: 13.5, lineHeight: 19 },

  reviewBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", paddingHorizontal: 24 },
  reviewCard: { backgroundColor: theme.surface, borderRadius: 18, borderWidth: 1, borderColor: theme.border, padding: 18 },
  reviewTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: "800", textAlign: "center" },
  reviewInput: { color: theme.textPrimary, fontSize: 14.5, minHeight: 70, backgroundColor: theme.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 12, textAlignVertical: "top", marginBottom: 12, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) },
});

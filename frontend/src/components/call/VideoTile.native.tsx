// Native: render a LiveKit video track. Uses @livekit/react-native's VideoTrack
// component (driven by a TrackReference: { participant, publication, source }).
//
// @livekit/react-native is required lazily inside render — never at module load —
// because it pulls in react-native-webrtc, a native module missing from Expo Go.
// This component only renders during an active call (which the call screen gates
// to dev builds), so the require is safe here.
import React from "react";
import { View } from "react-native";

export default function VideoTile({
  trackRef,
  style,
  mirror,
}: {
  trackRef: any;
  style?: any;
  mirror?: boolean;
}) {
  if (!trackRef?.publication?.track) return <View style={style} />;
  const { VideoTrack } = require("@livekit/react-native");
  return (
    <VideoTrack
      trackRef={trackRef}
      style={style}
      objectFit="cover"
      mirror={!!mirror}
    />
  );
}

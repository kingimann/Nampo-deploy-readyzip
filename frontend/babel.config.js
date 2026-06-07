// Babel config for the Expo app.
//
// `react-native-worklets/plugin` enables Reanimated 4 worklets (it replaces the
// old `react-native-reanimated/plugin` used by Reanimated 3). It MUST be the
// last entry in `plugins`. After adding/removing it, restart Metro with a
// cleared cache: `npx expo start --clear`.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-worklets/plugin"],
  };
};

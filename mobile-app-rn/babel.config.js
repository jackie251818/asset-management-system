module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    'react-native-reanimated/plugin',
    // react-native-worklets-core 插件必须放在最后（VisionCamera frame processor 依赖）
    'react-native-worklets-core/plugin',
  ],
};

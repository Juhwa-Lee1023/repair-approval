// Prints which settings are present. Never prints values.
import { loadConfig, configSummary } from '../src/config.js';
console.log(JSON.stringify(configSummary(loadConfig()), null, 2));

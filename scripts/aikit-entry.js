// TensorFlow.js plus the two models that use it, loaded only by Upscale and Blur face.
import * as tf from '@tensorflow/tfjs';
import * as faceapi from '@vladmandic/face-api/dist/face-api.esm-nobundle.js';
import Upscaler from 'upscaler';
import x2 from '@upscalerjs/esrgan-slim/2x';
import x4 from '@upscalerjs/esrgan-slim/4x';
export { tf, faceapi, Upscaler, x2, x4 };

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 128;
    this.sampleBuffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    this.noiseGate = 0.01; // Noise gate threshold
    this.compressionRatio = 0.8; // Gentle compression
    this.compressionThreshold = 0.7;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0];
      
      // Process audio in chunks for better performance
      for (let i = 0; i < channel.length; i++) {
        let sample = channel[i];
        
        // Apply noise gate
        if (Math.abs(sample) < this.noiseGate) {
          sample = 0;
        }
        
        // Apply gentle compression to prevent clipping
        if (Math.abs(sample) > this.compressionThreshold) {
          const excess = Math.abs(sample) - this.compressionThreshold;
          const compressedExcess = excess * this.compressionRatio;
          sample = sample > 0 ? 
            this.compressionThreshold + compressedExcess : 
            -(this.compressionThreshold + compressedExcess);
        }
        
        // Clamp to valid range
        sample = Math.max(-1, Math.min(1, sample));
        
        this.sampleBuffer[this.bufferIndex] = sample;
        this.bufferIndex++;
        
        // Send buffer when full
        if (this.bufferIndex >= this.bufferSize) {
          this.sendBuffer();
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
  
  sendBuffer() {
    // Convert to PCM16
    const pcm = new ArrayBuffer(this.sampleBuffer.length * 2);
    const view = new DataView(pcm);
    
    for (let i = 0; i < this.sampleBuffer.length; i++) {
      const sample = this.sampleBuffer[i];
      view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    }
    
    // Send with transfer to avoid copying
    this.port.postMessage(pcm, [pcm]);
  }
  
  static get parameterDescriptors() {
    return [
      {
        name: 'noiseGate',
        defaultValue: 0.01,
        minValue: 0,
        maxValue: 0.1
      },
      {
        name: 'compressionRatio',
        defaultValue: 0.8,
        minValue: 0.1,
        maxValue: 1.0
      }
    ];
  }
}

registerProcessor('pcm-processor', PCMProcessor);

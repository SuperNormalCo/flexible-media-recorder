import CanvasStreamProxy from './CanvasStreamProxy.js'
import FakeStreamFactory from './FakeStreamFactory.js'
import MediaStreamProxy from './MediaStreamProxy.js'

const defaults = {
  saveBlobs: true,
  timeSlice: 1000,
  onDataAvailable: () => {},
  onStart: () => {},
}

export default function WebRecorder(options = {}) {
  options = { ...defaults }
  // Video Part
  const fakeStreamFactory = new FakeStreamFactory()
  const mediaStreamProxy = new MediaStreamProxy()
  const canvasStreamProxy = new CanvasStreamProxy()

  // Audio Part
  const sourceNodeMap = new Map()
  let audioContext = null
  let audioDestination = null
  let mutedSourceNode = null

  // Recording Part
  let mediaRecorder = null
  let supportedType = null
  let targetStream = null
  let isRecording = false
  let recordedBlobList = []

  this.start = startRecording
  this.stop = stopRecording
  this.download = downloadRecording

  this.addAudioTrack = track => {
    if (!isRecording) {
      throw new Error('addAudioTrack: Recording is not in progress')
      return
    }

    if (!(track instanceof MediaStreamTrack)) {
      throw new Error('addAudioTrack: track is not a MediaStreamTrack')
      return
    }

    if (track.kind === 'audio') {
      if (sourceNodeMap.has(track.id)) {
        return
      }

      const audioStream = new MediaStream()
      audioStream.addTrack(track)

      const sourceNode = audioContext.createMediaStreamSource(audioStream)
      sourceNode.connect(audioDestination)
      sourceNodeMap.set(track.id, sourceNode)
    }
  }

  this.deleteAudioTrack = track => {
    if (!isRecording) {
      console.error('Recording is not in progress')
      return
    }

    if (!(track instanceof MediaStreamTrack)) {
      console.error('Invalid argument')
      return
    }

    if (track.kind === 'audio') {
      const sourceNode = sourceNodeMap.get(track.id)

      if (sourceNode) {
        sourceNode.disconnect()
        sourceNodeMap.delete(track.id)
      }
    }
  }

  this.replaceVideoTrack = track => {
    if (!isRecording) {
      console.error('Recording is not in progress')
      return
    }

    if (!(track instanceof MediaStreamTrack)) {
      console.error('Invalid argument')
      return
    }

    if (track.kind === 'video') {
      const stream = new MediaStream()
      stream.addTrack(track)
      canvasStreamProxy.replaceVideoStream(stream)
    }
  }

  this.replaceStream = stream => {
    if (!isRecording) {
      console.error('Recording is not in progress')
      return
    }

    if (!(stream instanceof MediaStream)) {
      console.error('Invalid argument')
      return
    }

    clearAudioTrack()

    stream.getTracks().forEach(track => {
      if (track.kind === 'video') {
        mediaStreamProxy.replaceVideoTrack(track)
      } else if (track.kind === 'audio') {
        if (sourceNodeMap.has(track.id)) {
          return
        }

        const audioStream = new MediaStream()
        audioStream.addTrack(track)

        const sourceNode = audioContext.createMediaStreamSource(audioStream)
        sourceNode.connect(audioDestination)
        sourceNodeMap.set(track.id, sourceNode)
      }
    })
  }

  this.getRecordedStream = () => {
    if (!isRecording) {
      console.error('Recording is not in progress')
      return
    }

    return targetStream
  }

  this.getRecordedBlob = () => {
    if (!recordedBlobList.length) {
      console.error('There is no recorded data')
      return
    }

    const blob = new Blob(recordedBlobList, { type: supportedType })

    return blob
  }

  async function startRecording(stream) {
    try {
      targetStream = await createTargetStream(stream)
    } catch (error) {
      console.error(error)
      return Promise.reject('TargetStream Error')
    }

    // reset recorded data
    recordedBlobList = []

    try {
      mediaRecorder = new MediaRecorder(targetStream, options)
    } catch (error) {
      console.error(error)
      return Promise.reject('MediaRecorder Error')
    }

    console.log('Created MediaRecorder', mediaRecorder, 'with options', options)
    mediaRecorder.addEventListener('stop', handleStop)
    mediaRecorder.addEventListener('dataavailable', handleDataAvailable)
    mediaRecorder.start(options.timeSlice) // collect 100ms of data blobs
    isRecording = true
    console.log('MediaRecorder started', mediaRecorder)
    console.log('onSTART', options.onStart)
    options.onStart()
  }

  function handleDataAvailable(event) {
    options.onDataAvailable(event)

    if (options.saveBlobs && event.data?.size > 0) {
      recordedBlobList.push(event.data)
    }
  }

  function handleStop(event) {
    console.log('Recorder stopped: ', event)
    isRecording = false

    resetVideoProcess()
    resetAudioProcess()

    // reset recording part
    targetStream.getTracks().forEach(track => track.stop())
    targetStream = null
    mediaRecorder = null
    supportedType = null
  }

  function stopRecording() {
    if (!isRecording) {
      console.error('Recording is not in progress')
      return
    }

    mediaRecorder.stop()
  }

  function downloadRecording(file_name) {
    if (!recordedBlobList.length) {
      console.error('There is no recorded data')
      return
    }

    const name = file_name || 'test.webm'
    const blob = new Blob(recordedBlobList, { type: supportedType })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.style.display = 'none'
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    }, 100)
  }

  async function createTargetStream(stream) {
    stream = stream || new MediaStream()

    if (!(stream instanceof MediaStream)) {
      return Promise.reject(new Error('Invalid argument'))
    }

    if (stream.getVideoTracks().length === 0) {
      const option = {
        videoType: 'black',
      }
      const fakeVideoTrack = fakeStreamFactory.getFakeVideoTrack(option)
      stream.addTrack(fakeVideoTrack)
    }

    const videoTrack = canvasStreamProxy.createCanvasStream(stream)
    const audioTrack = processAudioTrack(stream)

    const resultStream = new MediaStream()
    resultStream.addTrack(videoTrack)
    resultStream.addTrack(audioTrack)

    return Promise.resolve(resultStream)
  }

  function processAudioTrack(stream) {
    audioContext = new AudioContext()
    audioDestination = audioContext.createMediaStreamDestination()

    // default AudioSourceNode
    mutedSourceNode = audioContext.createBufferSource()
    mutedSourceNode.connect(audioDestination)

    stream
      .getTracks()
      .filter(track => {
        return track.kind === 'audio'
      })
      .forEach(function (track) {
        if (sourceNodeMap.has(track.id)) {
          return
        }

        const audioStream = new MediaStream()
        audioStream.addTrack(track)

        const sourceNode = audioContext.createMediaStreamSource(audioStream)
        sourceNode.connect(audioDestination)
        sourceNodeMap.set(track.id, sourceNode)
      })

    return audioDestination.stream.getAudioTracks()[0]
  }

  function clearAudioTrack() {
    sourceNodeMap.forEach(sourceNode => {
      sourceNode.disconnect()
    })
    sourceNodeMap.clear()
  }

  function resetVideoProcess() {
    fakeStreamFactory.releaseFakeStream()
    //mediaStreamProxy.disconnectLocalConnection();
    canvasStreamProxy.releaseCanvasStream()
  }

  function resetAudioProcess() {
    // reset sequence?
    sourceNodeMap.forEach(sourceNode => {
      sourceNode.disconnect()
    })
    sourceNodeMap.clear()

    if (mutedSourceNode) {
      mutedSourceNode.disconnect()
      mutedSourceNode = null
    }

    if (audioDestination) {
      audioDestination.disconnect()
      audioDestination = null
    }

    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
  }
}

samples('https://raw.githubusercontent.com/felixroos/dough-samples/main/tidal-drum-machines.json')

// The gritty 12-bit sampler behind the bare bd / hh / sd / cp you get with no bank:
samples('https://raw.githubusercontent.com/felixroos/dough-samples/main/EmuSP12.json')

setcps(1)
const ht = [
  "~ ~ ~ [~ ht]",
  "~ ~ [~ ht] [~ ht]",
]

const notes = [
  "[d#4 d#4 ~ ~] [d#4 ~ d#4 ~] [d#4 d#5 ~ ~] [b4 a#4 ~ ~]", 
  "[a4 a4 a4 a4 a#4 f#4 f4 d#4 ",
  "[d#5,d#6] [d#5,d#6] [d#5,d#6] [a#5,a#6] b6 [a#5,a#6] [a#5,a#6] [f#5,f#6] [f#5,f#6] [f#5,f#6] [d#5,d#6] [d#5,d#6] [d#5,d#6] [a#5,a#6] [a#5,a#6] [a#5,a#6] [f#5,f#6] [f#5,f#6] [f#5,f#6] [d#5,d#6] [d#5,d#6] [d#5,d#6] ",
  "[a#5,a#6] [g#5,g#6] [f#5,f#6] [g#5,g#6] [f#5,f#6] [d#5,d#6] ",
  "f3 g#3 f#3 f3 g#3 f#3 f3",
  "g#3 f#3 f3 g#3 f#3 f3 d#3 [a#3,c#4] f#3 f3",
  "f3 f3 f3 f3 a#3 g#3 g3 d#3 ",
]



stack(
  s("lt lt lt lt").bank("RolandTR808"),
  s(pick(ht, "<0 1>")).bank("RolandTR808"),//.slow(2)
  note(pick(notes, "<0 1>")).sound("sawtooth").slow(2)
  
  
  
  
  
)


 //ambientarp: note(pick(arp2Notes, "<0 1 2>"))

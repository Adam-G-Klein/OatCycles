const gainnn = [
  "2",
  "{0.75 2.5}*4",
  "{0.75 2.5!9 0.75 2.5!5 0.75 2.5 0.75 2.5!7 0.75 2.5!3 <2.5 0.75> 2.5}%16"
]


const Structures = [
  "~",
  "x*4",
  "{x ~!9 x ~!5 x ~ x ~!7 x ~!3 < ~ x > ~}%16"
]

const gooo = 1

bassline: note("[eb1, eb2]!16 [f2, f1]!16 [g2, g1]!16 [f2, f1]!8 [bb2, bb1]!8")
.sound("supersaw")
.slow(8)
//.postgain(2)
//.room(0.6)
.lpf(725)
//.room(0.4)
.postgain(pick(gainnn, gooo))

const arpeggiator = [
  "{"
]

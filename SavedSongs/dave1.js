const gainnn = [
  "2",
  "{0.3 0.6}*4",
  "{0.75 2.5!9 0.75 2.5!5 0.75 2.5 0.75 2.5!7 0.75 2.5!3 <2.5 0.75> 2.5}%16"
]


const Structures = [
  "~",
  "x*4",
  "{x ~!9 x ~!5 x ~ x ~!7 x ~!3 < ~ x > ~}%16"
]

const gooo = 1

const bassNotes = [
  "[0, 8]",
  "[f1, f2]",
  "[g1, g2]",
  "[f1, f2]",
  "[bb1, bb2]"
]

/*
bassline: note(pick(bassNotes, "0!16 1!16 2!16 3!8 4!8"))
.sound("supersaw")
//.slow(8)
.postgain(2)
.room(0.6)
.lpf(slider(600,700,1500))
.room(0.4)
.postgain(pick(gainnn, gooo))
.punchcard({height: 200, width: 1000})
*/

bassline: note("[0, 8]!16 [1, 9]!16 [2, 10]!16 [1, 9]!8 [4, 12]!8")
  .scale("Eb1:major")
.sound("supersaw")
.slow(8)
//.postgain(2)
.room(0.6)
.lpf(slider(600,700,1500))
.room(0.4)
.postgain(pick(gainnn, gooo))
.punchcard({height: 200, width: 1000})

const movements = [
  
]

/*
const arp1Notes = [
  "{eb3 f3 g3 eb3 f3 g3 ~ ~}%8",
  "{eb3 ~ g3 ~ f3 ~ ~ ~}%8",
  "{g3 ~ f3 ~ eb3 ~ g3 ~}%8",
]
*/
const arp1Notes = [
  "{0 1 2 0 1 2 ~ ~}%8",
  "{0 ~ 2 ~ 1 ~ ~ ~}%8",
  "{2 ~ 1 ~ 0 ~ 2 ~}%8",
]

const arp2Notes = [
  "{4 3 2 4 3 2 ~ ~}%8",
  "{2 ~ 0 ~ 4 ~ ~ ~}%8",
  "{4 ~ 2 ~ 2 1 0 ~}%8",
]

 ambientarp: note(pick(arp2Notes, "<0 1 2>"))
   .scale("Eb2:major:pentatonic")
 .sound("supersaw")
 .lpf(slider(373.25,50,800))
 .sustain(slider(0.6681, 0.1, 2)).release(slider(0.33437, 0.01, 2)).attack(slider(0.04871, 0.01, 0.5))
 .postgain(2)


/*
highArp: note(pick(arpNotes, "~!2 ~!2 {eb3 ~ f3 ~ g3 ~} ~ ~!2"))
.sound("supersaw")
.lpf(slider(1193.6, 400, 2000))
.sustain(0.5).release(0.01).attack(0.01)
.postgain(2)
*/



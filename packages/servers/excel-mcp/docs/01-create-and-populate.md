# Faz 1: yeni Excel oluşturma ve temel yazma

Durum: kapsam önerisi. [Faz 0](00-write-foundation.md) temelini kullanır; kaynak koruma, ayrı hesaplama ve aynı pakette ayrıca etkinleştirilen yazma modu kararları [ana yol haritasında](README.md) kesindir.

## Hedef

Agent yeni bir dosya oluşturabilsin, doğrudan verdiği verileri toplu yazabilsin ve konuşmanın devamında bu dosyada temel değişiklikler yapabilsin.

## Kapsam

| Kimlik | İhtiyaç                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F1-01  | Yeni çalışma kitabı oluşturmak; ilk biçim önerisi .xlsx.                                                                                 |
| F1-02  | Bir veya birden fazla sayfa oluşturmak ve adlandırmak.                                                                                   |
| F1-03  | En az bir sayfası bulunan boş dosya veya yalnızca başlıkları olan yapı oluşturmak.                                                       |
| F1-04  | Belirli bir başlangıçtan itibaren tek hücre, satır veya dikdörtgen veri grubunu yazmak.                                                  |
| F1-05  | Agent'ın açıkça seçtiği desteklenen hücre türünü ve kayıt sırasını korumak; metni kendiliğinden tarihe veya formüle dönüştürmemek.       |
| F1-06  | Sonraki istekte seçilen çıktı sürümünü kaynak alarak hücre düzeltme, kayıt veya sayfa ekleme yapıp yeni sürüm üretmek.                   |
| F1-07  | Güncel çıktı sürümünü, tamamlanma durumunu ve değişiklik kapsamını küçük bir sonuçla bildirmek; bütün yazılan veriyi tekrar döndürmemek. |

Hücre türünü agent'ın belirleyip yazıcıya açıkça bildirmesi K1-08 ile kesindir. Tarih/saat, sayı, metin, mantıksal değer, boş hücre ve boş metin için ilk destek kapsamı birlikte belirlenecek. Başında sıfır bulunan kimlik ve uzun numara örnekleri, tür anlamının korunması açısından değerlendirilir.

## Kodlama iş paketleri

1. Faz 0'ın kaynak/çıktı, değer, işlem sınırı ve bütçe kurallarını ilk çalışan oluşturma akışına bağlamak.
2. Dosya/sayfa oluşturma ve doğrudan verilen veri grubunu yazma yeteneğini eklemek.
3. Desteklenen türler, eksik alanlar, alan boyutu ve dolu hedef gibi durumları ele almak.
4. Sonraki istekte seçilen sürümden basit değer düzeltme ve kayıt eklemeyle yeni çıktı üretme akışını tamamlamak.
5. Çıktı üretme, hata durumları, yeniden okuma ve bağımsız dosya doğrulamasını tamamlamak.

## Bağımlılıklar ve sınırlar

- Yazma aynı paketin ayrıca etkinleştirilen modunda sunulur; varsayılan okuma davranışı korunur.
- Kaynak ve önceki çıktı sürümleri korunur; dosya adının aynı olması kaynak üzerine yazma izni değildir.
- Başlangıçta başka Excel'den veri aktarımı gerekmez; bu Faz 2'dir.
- Dışarıdan gelen karmaşık dosyayı koruyarak düzenleme Faz 3'tür.
- Koşullu güncelleme ve anahtarla kayıt eşleştirme Faz 4'te tamamlanır. Agent mevcut okumayla bir hedef belirleyebilir; Faz 1'in yazma kapsamı açıkça hedeflenen değişikliklerle sınırlı önerilir.
- Formül oluşturma ve görünüm özellikleri Faz 5'tedir. Desteklenmeyen içerik yanlışlıkla desteklenmiş gibi yazılmamalıdır.
- Oluşturulan dosyada basit ekleme ile altında toplam/not bulunan karmaşık listeye yer açmak aynı kapsam değildir.

## Kabul senaryoları

- Agent Giderler sayfası, başlıklar ve örnek kayıt grubuyla dosya oluşturur.
- Sonraki istekte yeni kayıt grubu ve Gelirler sayfası ekler; açıkça hedeflenen tutarı düzeltir. Yeni çıktı sürümünde sonuç görünür; kaynak ve önceki sürüm değişmez.
- Dosya açılır; tekrar okunduğunda sayfalar, değerler, sıralama ve düzeltme beklenen durumdadır.
- Boş ve yalnızca başlıklı çıktı istekleri doğru karşılanır.
- Üzerinde uzlaşılan büyüklükte toplu yazma tamamlanır; aynı veri hücre hücre tarif edilmek zorunda kalmaz.
- Hatalı veri veya dolu hedef örneğinde üzerinde uzlaşılan davranış gerçekleşir; başarısız iş tamamlanmış gibi gösterilmez.
- Yazma sonucunun boyutu yazılan bütün veriyi tekrar etmeye dayanmaz; aynı ekleme isteğinin yeniden denenmesi kararlaştırılmış sonucu verir.
- Mevcut okuma davranışları korunur.

## Açık kararlar

Ana belgedeki A-01–A-04 bu fazı ilgilendirir. Kaynağı koruyup yeni sürüm üretme kesindir. Aynı sayfa adı, hedef boyutu, eksik alan ve yeniden deneme ayrıntıları Faz 0 kurallarıyla tamamlanır. Formül yazma kapsamına Faz 5'te geçilir; literal = metnini koruyabilmek için o faz beklenmez.

Önerilen tamamlanma ölçütü: doğrudan veriyle oluşturma → konuşmada devam etme → sonucu elde etme akışının, kabul edilmiş değer türleri ve ölçek üzerinde uçtan uca çalışması.
